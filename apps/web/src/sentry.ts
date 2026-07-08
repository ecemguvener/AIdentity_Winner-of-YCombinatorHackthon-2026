import * as Sentry from "@sentry/react";

const redacted = "[redacted]";
const sensitiveKeys = new Set(["authorization", "cookie", "password", "email", "transcript", "body"]);

export function initSentry(): void {
  if (!import.meta.env.VITE_SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    tracesSampleRate: 0.1,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    beforeSend: (event) => scrubSentryEvent(event) as Sentry.ErrorEvent
  });
}

function scrubSentryEvent(event: Sentry.Event): Sentry.Event {
  return scrubObject(event) as Sentry.Event;
}

function scrubObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubObject(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ? redacted : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKeys.has(key) || sensitiveKeys.has(key.toLowerCase()) ? redacted : scrubObject(item)
  ]));
}
