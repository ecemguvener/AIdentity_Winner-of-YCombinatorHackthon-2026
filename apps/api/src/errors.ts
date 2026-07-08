import { ZodError } from "zod";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "validation_failed"
  | "provider_error"
  | "policy_blocked"
  | "approval_required"
  | "plan_limit"
  | "already_claimed"
  | "internal";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface ApiErrorPayload {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
  message: string;
}

export function buildErrorPayload(error: ApiError, requestId: string): ApiErrorPayload {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details })
    },
    message: error.message
  };
}

export function validationApiError(error: ZodError): ApiError {
  return new ApiError(400, "validation_failed", "invalid request", error.flatten());
}

export function codeForStatus(statusCode: number): ApiErrorCode {
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) return "forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 400 && statusCode < 500) return "validation_failed";
  return "internal";
}
