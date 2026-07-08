import type { ApiErrorEnvelope } from "./types";

const configuredApiBaseUrl = import.meta.env.VITE_API_URL || "";
const configuredApiPort = import.meta.env.VITE_API_PORT || "";
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(input: { status: number; code: string; message: string; requestId?: string | null; details?: unknown }) {
    super(input.message);
    this.name = "ApiClientError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.details = input.details;
  }
}

interface PlanLimitDetails {
  plan?: string;
  upgradeHint?: string;
}

export type RequestJsonOptions = RequestInit & {
  apiBaseUrlOverride?: string;
};

export async function requestJson<T>(path: string, options: RequestJsonOptions = {}): Promise<T> {
  const { apiBaseUrlOverride, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);

  if (requestOptions.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBaseUrlOverride ?? apiBaseUrl}${path}`, {
    credentials: "include",
    headers,
    ...requestOptions
  });

  if (!response.ok) {
    throw await buildApiClientError(response);
  }

  return await response.json() as T;
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

function resolveApiBaseUrl(configuredUrl: string): string {
  if (typeof window === "undefined") {
    return stripTrailingSlash(configuredUrl);
  }

  if (!configuredUrl) {
    return "";
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
      return stripTrailingSlash(apiUrl.toString());
    }
  } catch {
    return stripTrailingSlash(configuredUrl);
  }

  return stripTrailingSlash(configuredUrl);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

const apiBaseUrl = resolveApiBaseUrl(configuredApiBaseUrl);

async function buildApiClientError(response: Response): Promise<ApiClientError> {
  const text = await response.text();
  const fallbackMessage = getHttpErrorFallback(response);

  try {
    const parsed = JSON.parse(text) as ApiErrorEnvelope;
    const envelope = parsed.error;
    const message = parsed.message || envelope?.message || fallbackMessage;
    const error = new ApiClientError({
      status: response.status,
      code: envelope?.code || codeForStatus(response.status),
      message,
      requestId: envelope?.requestId ?? null,
      details: envelope?.details
    });
    notifyPlanLimit(error);
    return error;
  } catch {
    return new ApiClientError({
      status: response.status,
      code: codeForStatus(response.status),
      message: fallbackMessage
    });
  }
}

function notifyPlanLimit(error: ApiClientError): void {
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

function isPlanLimitDetails(value: unknown): value is PlanLimitDetails {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codeForStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "validation_failed";
  return "internal";
}

function getHttpErrorFallback(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `${response.status} ${statusText}` : "request failed";
}
