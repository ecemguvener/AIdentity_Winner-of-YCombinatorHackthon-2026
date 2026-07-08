export interface User {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  notificationPreferences: UserNotificationPreferences;
  onboarding: OnboardingState;
  createdAt: string;
}

export type OnboardingStep = "agent_created" | "runtime_connected" | "first_email_sent" | "approval_decided";

export interface OnboardingState {
  dismissedAt: string | null;
  completedAt: string | null;
  steps: Record<OnboardingStep, string | null>;
  events: Array<{ step: OnboardingStep | "phone_added"; at: string; metadata: Record<string, unknown> }>;
}

export interface UserNotificationPreferences {
  productEmails: boolean;
  identityEmails: boolean;
  securityEmails: boolean;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  publicSiteKey: string;
  previewImage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardChatMessageInput {
  role: "user" | "assistant";
  content: string;
}

export type DashboardChatStreamEvent =
  | { type: "ready"; model?: string }
  | { type: "delta"; text: string }
  | { type: "call_started"; call: DashboardChatCallEmbed }
  | { type: "call_completed"; call: DashboardChatCallEmbed }
  | { type: "done" }
  | { type: "error"; error: string };

export interface DashboardChatCallTranscriptTurn {
  role: string;
  message: string;
  timeInCallSecs: number | null;
}

export interface DashboardChatCallEmbed {
  callId: string;
  toNumber: string;
  recipientName: string;
  agentIdentityName: string;
  task: string;
  status: string;
  simulated: boolean;
  durationSecs?: number | null;
  transcript?: DashboardChatCallTranscriptTurn[];
}

const configuredApiBaseUrl = import.meta.env.VITE_API_URL || "";
const configuredApiPort = import.meta.env.VITE_API_PORT || "";
const fallbackApiPort = "4001";
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function resolveApiBaseUrl(configuredUrl: string): string {
  if (typeof window === "undefined") {
    return stripTrailingSlash(configuredUrl);
  }

  if (!configuredUrl) {
    return localHostnames.has(window.location.hostname)
      ? ""
      : `${window.location.protocol}//${window.location.hostname}:${configuredApiPort || fallbackApiPort}`;
  }

  try {
    const apiUrl = new URL(configuredUrl);
    if (localHostnames.has(apiUrl.hostname)) {
      if (!localHostnames.has(window.location.hostname)) {
        apiUrl.hostname = window.location.hostname;
      }
      if (configuredApiPort) {
        apiUrl.port = configuredApiPort;
      }
      return apiUrl.toString().replace(/\/$/, "");
    }
  } catch {
    return stripTrailingSlash(configuredUrl);
  }

  return stripTrailingSlash(configuredUrl);
}

const apiBaseUrl = resolveApiBaseUrl(configuredApiBaseUrl);
const forcedLogoutStorageKey = "barkan:forced-logout";

type ApiRequestOptions = RequestInit & {
  apiBaseUrlOverride?: string;
};

export class ApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { apiBaseUrlOverride, ...requestOptions } = options;
  const requestBaseUrl = apiBaseUrlOverride ?? apiBaseUrl;
  const headers = new Headers(requestOptions.headers);

  if (requestOptions.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${requestBaseUrl}${path}`, {
    credentials: "include",
    headers,
    ...requestOptions
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = parseApiError(text, getHttpErrorFallback(response));
    const error = new ApiHttpError(parsed.message, response.status, parsed.code, parsed.details);
    notifyPlanLimit(error);
    throw error;
  }

  return (await response.json()) as T;
}

async function apiRequestWithBaseUrlFallback<T>(
  path: string,
  options: ApiRequestOptions,
  candidateBaseUrls: string[]
): Promise<T> {
  let lastError: unknown = null;

  for (const candidateBaseUrl of candidateBaseUrls) {
    try {
      return await apiRequest<T>(path, {
        ...options,
        apiBaseUrlOverride: candidateBaseUrl
      });
    } catch (error) {
      if (error instanceof ApiHttpError) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("request failed");
}

export const api = {
  hasForcedLogout: () => localStorage.getItem(forcedLogoutStorageKey) === "true",
  markForcedLogout: () => localStorage.setItem(forcedLogoutStorageKey, "true"),
  clearForcedLogout: () => localStorage.removeItem(forcedLogoutStorageKey),
  me: () => apiRequest<{ user: User }>("/api/auth/me"),
  updateProfile: (updates: { displayName?: string; email?: string; avatarUrl?: string | null }) =>
    apiRequest<{ user: User }>("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(updates)
    }),
  updateNotificationPreferences: (preferences: UserNotificationPreferences) =>
    apiRequest<{ user: User }>("/api/auth/me/notifications", {
      method: "PATCH",
      body: JSON.stringify(preferences)
    }),
  updatePassword: (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: boolean }>("/api/auth/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    }),
  updateOnboarding: (dismissed: boolean) =>
    apiRequest<{ onboarding: OnboardingState }>("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ dismissed })
    }),
  checkEmail: (email: string) =>
    apiRequestWithBaseUrlFallback<{ exists: boolean }>(
      "/api/auth/check-email",
      {
        method: "POST",
        body: JSON.stringify({ email })
      },
      getEmailLookupBaseUrlCandidates()
    ),
  signup: (email: string, password: string) =>
    apiRequest<{ user: User }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  login: (email: string, password: string) =>
    apiRequest<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  logout: async () => {
    const candidateBaseUrls = getLogoutBaseUrlCandidates();
    let lastError: unknown = null;
    let didLogout = false;

    for (const candidateBaseUrl of candidateBaseUrls) {
      try {
        await apiRequest<{ ok: boolean }>("/api/auth/logout", {
          method: "POST",
          apiBaseUrlOverride: candidateBaseUrl
        });
        didLogout = true;
      } catch (error) {
        lastError = error;
      }
    }

    if (didLogout) {
      return { ok: true };
    }

    throw lastError instanceof Error ? lastError : new Error("logout failed");
  },
  sendDashboardChatMessage: (messages: DashboardChatMessageInput[], onEvent: (event: DashboardChatStreamEvent) => void) =>
    streamDashboardChatMessage(messages, onEvent),

  // --- Email tool (per agent identity / site, authenticated by the session) ---
  getSiteEmailActivity: (siteId: string) =>
    apiRequest<EmailActivity>(`/api/sites/${siteId}/email-activity`),
  siteRequestEmailFromText: (siteId: string, request: string, to?: string) =>
    apiRequest<EmailSendResult & { parsed: ParsedEmail | null }>(`/api/sites/${siteId}/email/request`, {
      method: "POST",
      body: JSON.stringify(to ? { request, to } : { request })
    }),
  siteSendEmail: (siteId: string, input: EmailSendInput) =>
    apiRequest<EmailSendResult>(`/api/sites/${siteId}/email/send`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  sitePauseEmail: (siteId: string) =>
    apiRequest<EmailIdentityView>(`/api/sites/${siteId}/email/pause`, { method: "POST" }),
  siteResumeEmail: (siteId: string) =>
    apiRequest<EmailIdentityView>(`/api/sites/${siteId}/email/resume`, { method: "POST" })
};

export interface EmailIdentityView {
  email_identity_id: string;
  email_address: string;
  display_name: string;
  provider: string;
  status: "active" | "paused";
  created_at: string;
}

export interface ParsedEmail {
  to: string | null;
  recipient_name: string | null;
  subject: string;
  body: string;
  parsed_by: "openai" | "heuristic";
}

export interface EmailSendInput {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSendResult {
  ok: boolean;
  message_id: string;
  thread_id: string;
  provider_message_id: string | null;
  from: string;
  to: string;
  subject: string;
  status: "sent" | "failed" | "received";
}

export interface EmailMessageView {
  id: string;
  thread_id: string;
  direction: "outbound" | "inbound";
  from_email: string;
  to_email: string;
  subject: string;
  body: string;
  provider_message_id: string | null;
  status: "sent" | "failed" | "received";
  parsed_by: string | null;
  created_at: string;
}

export interface EmailReplyNotificationView {
  id: string;
  email_message_id: string;
  thread_id: string;
  from_email: string;
  subject: string;
  summary: string;
  suggested_reply: string;
  status: "unread" | "read";
  created_at: string;
}

export interface EmailActivity {
  account_id: string;
  email_identity: EmailIdentityView | null;
  messages: EmailMessageView[];
  reply_notifications: EmailReplyNotificationView[];
}

async function streamDashboardChatMessage(
  messages: DashboardChatMessageInput[],
  onEvent: (event: DashboardChatStreamEvent) => void
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/dashboard/chat`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ messages })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(parseApiError(text, getHttpErrorFallback(response)).message);
  }

  if (!response.body) {
    throw new Error("Chat stream is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const eventBlocks = buffer.split(/\n\n/);
    buffer = eventBlocks.pop() ?? "";

    for (const eventBlock of eventBlocks) {
      const event = parseDashboardChatStreamEvent(eventBlock);
      if (!event) {
        continue;
      }

      onEvent(event);
      if (event.type === "error") {
        throw new Error(event.error);
      }
    }

    if (done) {
      break;
    }
  }

  const finalEvent = parseDashboardChatStreamEvent(`${buffer}\n\n`);
  if (finalEvent) {
    onEvent(finalEvent);
    if (finalEvent.type === "error") {
      throw new Error(finalEvent.error);
    }
  }
}

function parseDashboardChatStreamEvent(block: string): DashboardChatStreamEvent | null {
  const dataLine = block
    .split(/\n/)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);

  if (!dataLine) {
    return null;
  }

  const data = JSON.parse(dataLine) as Record<string, unknown>;
  if (data.type === "ready") {
    return { type: "ready", ...(typeof data.model === "string" ? { model: data.model } : {}) };
  }
  if (data.type === "delta" && typeof data.text === "string") {
    return { type: "delta", text: data.text };
  }
  if (data.type === "call_started" && isDashboardChatCallEmbed(data.call)) {
    return { type: "call_started", call: data.call };
  }
  if (data.type === "call_completed" && isDashboardChatCallEmbed(data.call)) {
    return { type: "call_completed", call: data.call };
  }
  if (data.type === "done") {
    return { type: "done" };
  }
  if (data.type === "error") {
    return { type: "error", error: typeof data.error === "string" ? data.error : "Chat response failed" };
  }

  return null;
}

function isDashboardChatCallEmbed(value: unknown): value is DashboardChatCallEmbed {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const call = value as DashboardChatCallEmbed;
  const transcript = call.transcript;
  return (
    typeof call.callId === "string" &&
    typeof call.toNumber === "string" &&
    typeof call.recipientName === "string" &&
    typeof call.agentIdentityName === "string" &&
    typeof call.task === "string" &&
    typeof call.status === "string" &&
    typeof call.simulated === "boolean" &&
    (transcript === undefined || transcript.every(isDashboardChatCallTranscriptTurn))
  );
}

function isDashboardChatCallTranscriptTurn(value: unknown): value is DashboardChatCallTranscriptTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const turn = value as DashboardChatCallTranscriptTurn;
  return (
    typeof turn.role === "string" &&
    typeof turn.message === "string" &&
    (typeof turn.timeInCallSecs === "number" || turn.timeInCallSecs === null)
  );
}

function parseApiError(text: string, fallback = "request failed"): { message: string; code?: string; details?: unknown } {
  try {
    const parsed = JSON.parse(text) as {
      error?: string | {
        code?: string;
        message?: string;
        details?: unknown;
      };
      message?: string;
      details?: unknown;
    };
    const details = typeof parsed.error === "object" && parsed.error !== null ? parsed.error.details ?? parsed.details : parsed.details;
    const nestedMessage = typeof parsed.error === "object" && parsed.error !== null ? parsed.error.message : undefined;
    const legacyMessage = typeof parsed.error === "string" ? parsed.error : undefined;
    const validationDetails = isValidationDetails(details) ? details : undefined;
    const fieldError = Object.values(validationDetails?.fieldErrors ?? {})
      .flatMap((messages) => messages ?? [])
      .find((message) => message.trim());
    const formError = validationDetails?.formErrors?.find((message) => message.trim());

    return {
      message: fieldError || formError || parsed.message || nestedMessage || legacyMessage || fallback,
      code: typeof parsed.error === "object" && parsed.error !== null ? parsed.error.code : undefined,
      details
    };
  } catch {
    return { message: fallback };
  }
}

function notifyPlanLimit(error: ApiHttpError): void {
  if (error.code !== "plan_limit" || typeof window === "undefined") return;
  const details = isPlanLimitDetails(error.details) ? error.details : {};
  window.dispatchEvent(new CustomEvent("barkan:plan-limit", {
    detail: {
      message: error.message,
      plan: details.plan,
      upgradeHint: details.upgradeHint
    }
  }));
}

function isPlanLimitDetails(value: unknown): value is { plan?: string; upgradeHint?: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidationDetails(value: unknown): value is {
  fieldErrors?: Record<string, string[] | undefined>;
  formErrors?: string[];
} {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getHttpErrorFallback(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `${response.status} ${statusText}` : "request failed";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function getLogoutBaseUrlCandidates(): string[] {
  const candidates = apiBaseUrl ? [apiBaseUrl] : [""];

  if (typeof window !== "undefined" && !localHostnames.has(window.location.hostname)) {
    const currentApiPort = new URL(apiBaseUrl).port || configuredApiPort || fallbackApiPort;
    candidates.push(`${window.location.protocol}//${window.location.hostname}:${currentApiPort}`);
    candidates.push(`${window.location.protocol}//${window.location.hostname}:${fallbackApiPort}`);
  }

  return [...new Set(candidates.map(stripTrailingSlash))];
}

function getEmailLookupBaseUrlCandidates(): string[] {
  const candidates = [apiBaseUrl, ""];

  if (typeof window !== "undefined" && !localHostnames.has(window.location.hostname)) {
    candidates.push(`${window.location.protocol}//${window.location.hostname}:${fallbackApiPort}`);
  }

  return [...new Set(candidates.map(stripTrailingSlash))];
}
