import * as Sentry from "@sentry/node";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

const redacted = "[redacted]";
const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "currentPassword",
  "newPassword",
  "email",
  "fromEmail",
  "toEmail",
  "counterpartyEmail",
  "textBody",
  "htmlBody",
  "transcript",
  "body",
  "rawBody"
]);

let initialized = false;

export function initSentry(config: AppConfig): void {
  if (!config.SENTRY_DSN || initialized) {
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    tracesSampleRate: 0.1,
    release: process.env.SENTRY_RELEASE ?? process.env.GIT_SHA,
    environment: config.NODE_ENV,
    beforeSend: (event) => scrubSentryEvent(event) as Sentry.ErrorEvent
  });
  initialized = true;
}

export function captureRequestException(error: unknown, request: FastifyRequest): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag("route", request.routeOptions.url ?? normalizedUrl(request.url));
    scope.setTag("method", request.method);
    scope.setTag("requestId", request.id);
    const userId = readHexId((request as { authUserId?: unknown }).authUserId);
    if (userId) {
      scope.setUser({ id: userId });
    }
    const agentId = readHexId(request.agentContext?.agent._id);
    if (agentId) {
      scope.setTag("agentId", agentId);
    }
    Sentry.captureException(error);
  });
}

export function captureOperationalAlert(message: string, extra: Record<string, unknown> = {}): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setLevel("fatal");
    scope.setContext("alert", scrubObject(extra) as Record<string, unknown>);
    Sentry.captureMessage(message);
  });
}

export function scrubSentryEvent(event: Sentry.Event): Sentry.Event {
  return scrubObject(event) as Sentry.Event;
}

export function scrubObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubObject(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && looksSensitive(value) ? redacted : value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKeys.has(key) || sensitiveKeys.has(key.toLowerCase())) {
      output[key] = redacted;
    } else {
      output[key] = scrubObject(item);
    }
  }
  return output;
}

function looksSensitive(value: string): boolean {
  return /^Bearer\s+/i.test(value) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value);
}

function readHexId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("toHexString" in value)) {
    return null;
  }
  const toHexString = (value as { toHexString?: unknown }).toHexString;
  return typeof toHexString === "function" ? String(toHexString.call(value)) : null;
}

function normalizedUrl(url: string): string {
  return url.split("?")[0]?.replace(/[a-f0-9]{24}/gi, ":id") ?? url;
}
