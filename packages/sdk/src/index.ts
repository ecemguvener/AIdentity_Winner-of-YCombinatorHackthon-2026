import type { paths } from "./generated/api.js";

type Json = Record<string, unknown>;
type FetchLike = typeof fetch;
type HttpMethod = "GET" | "POST";
type AgentWhoami = NonNullable<unknown>;
type EmailSendBody = Json & { to: string; subject: string; text: string; waitForApproval?: boolean };
type ApprovalStatus = { approval: { id: string; status: string; executionResult?: unknown; executionError?: string | null } };

export interface BarkanOptions {
  apiUrl?: string;
  token?: string;
  fetch?: FetchLike;
}

export class BarkanError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId: string | null = null,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "BarkanError";
  }
}

export class ApprovalPendingError extends BarkanError {
  constructor(readonly approvalId: string, message = "approval is pending") {
    super("approval_required", message, 202);
    this.name = "ApprovalPendingError";
  }
}

export class Barkan {
  readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: BarkanOptions = {}) {
    this.apiUrl = (options.apiUrl ?? process.env.BARKAN_API_URL ?? "https://aidentity.space").replace(/\/$/, "");
    this.token = options.token ?? process.env.BARKAN_IDENTITY_TOKEN ?? "";
    if (!this.token) {
      throw new BarkanError("unauthorized", "missing BARKAN_IDENTITY_TOKEN", 401);
    }
    this.fetchImpl = options.fetch ?? fetch;
  }

  whoami = () => this.request<AgentWhoami>("GET", "/api/v1/agent/whoami");

  email = {
    send: (input: EmailSendBody) => this.postWithApproval("/api/v1/agent/email/send", input),
    threads: {
      list: (cursor?: string) => this.request("GET", withQuery("/api/v1/agent/email/threads", { cursor })),
      get: (threadId: string) => this.request("GET", `/api/v1/agent/email/threads/${encodeURIComponent(threadId)}`)
    },
    reply: (threadId: string, input: { text: string; waitForApproval?: boolean }) =>
      this.postWithApproval(`/api/v1/agent/email/threads/${encodeURIComponent(threadId)}/reply`, input)
  };

  phone = {
    call: (input: { to: string; task: string; context?: string; recipientName?: string; waitForApproval?: boolean }) =>
      this.postWithApproval("/api/v1/agent/phone/call", input),
    calls: {
      list: (cursor?: string) => this.request("GET", withQuery("/api/v1/agent/phone/calls", { cursor })),
      get: (callId: string) => this.request("GET", `/api/v1/agent/phone/calls/${encodeURIComponent(callId)}`)
    },
    waitForCompletion: async (callId: string, options: { timeoutMs?: number; intervalMs?: number } = {}) => {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      const intervalMs = options.intervalMs ?? 2000;
      while (Date.now() < deadline) {
        const response = await this.phone.calls.get(callId) as { call?: { status?: string } };
        const status = response.call?.status;
        if (status && ["completed", "failed", "no_answer"].includes(status)) return response;
        await sleep(intervalMs);
      }
      throw new BarkanError("validation_failed", "phone call did not complete before timeout", 408);
    }
  };

  sms = {
    send: (input: { to: string; body: string; waitForApproval?: boolean }) =>
      this.postWithApproval("/api/v1/agent/phone/sms", input),
    conversation: (input: { with: string; cursor?: string }) =>
      this.request("GET", withQuery("/api/v1/agent/phone/sms", input)),
    latestCode: (input: { from?: string; sinceMinutes?: number } = {}) => {
      const since = input.sinceMinutes ? new Date(Date.now() - input.sinceMinutes * 60_000).toISOString() : undefined;
      return this.request("GET", withQuery("/api/v1/agent/phone/sms/latest-code", { from: input.from, since }));
    }
  };

  approvals = {
    get: (approvalId: string) => this.request<ApprovalStatus>("GET", `/api/v1/agent/approvals/${encodeURIComponent(approvalId)}`),
    waitFor: async (approvalId: string, options: { timeoutMs?: number; intervalMs?: number } = {}) => {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      const intervalMs = options.intervalMs ?? 2000;
      while (Date.now() < deadline) {
        const response = await this.approvals.get(approvalId);
        if (response.approval.status !== "pending") return response;
        await sleep(intervalMs);
      }
      throw new ApprovalPendingError(approvalId);
    }
  };

  audit = {
    recent: (limit?: number) => this.request("GET", withQuery("/api/v1/agent/audit/recent", { limit }))
  };

  private async postWithApproval(path: string, input: Json & { waitForApproval?: boolean }) {
    const { waitForApproval = true, ...body } = input;
    const query = waitForApproval ? { wait: 120 } : { mode: "async" };
    const response = await this.request<Json>("POST", withQuery(path, query), body);
    if (isApprovalPending(response)) {
      throw new ApprovalPendingError(response.approval_id, response.approval?.payloadSummary ?? "approval is pending");
    }
    return response;
  }

  private async request<T = Json>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const attempts = method === "GET" ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        if (response.status >= 500 && method === "GET" && attempt < attempts - 1) {
          lastError = await errorFromResponse(response);
          continue;
        }
        if (!response.ok) throw await errorFromResponse(response);
        return await response.json() as T;
      } catch (error) {
        lastError = error;
        if (method !== "GET" || error instanceof BarkanError || attempt === attempts - 1) break;
      }
    }
    throw lastError instanceof Error ? lastError : new BarkanError("internal", "request failed", 500);
  }
}

export type BarkanApiPaths = paths;

async function errorFromResponse(response: Response): Promise<BarkanError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; requestId?: string; details?: unknown }; message?: string };
    return new BarkanError(
      parsed.error?.code ?? codeForStatus(response.status),
      parsed.error?.message ?? parsed.message ?? response.statusText,
      response.status,
      parsed.error?.requestId ?? null,
      parsed.error?.details
    );
  } catch {
    return new BarkanError(codeForStatus(response.status), response.statusText || "request failed", response.status);
  }
}

function withQuery(path: string, query: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function isApprovalPending(value: Json): value is Json & { approval_id: string; approval?: { payloadSummary?: string } } {
  return value.ok === false && value.status === "approval_required" && typeof value.approval_id === "string";
}

function codeForStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "validation_failed";
  return "internal";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
