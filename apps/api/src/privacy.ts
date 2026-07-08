import crypto from "node:crypto";
import type { AppConfig } from "./config.js";
import { normalizeEmail } from "./security.js";

const DELETED_EMAIL_HOLD_DAYS = 30;

export function deletedEmailHash(email: string, config: AppConfig): string {
  return crypto
    .createHmac("sha256", config.SESSION_SECRET)
    .update(normalizeEmail(email))
    .digest("hex");
}

export function deletedEmailHoldExpiresAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + DELETED_EMAIL_HOLD_DAYS * 24 * 60 * 60 * 1000);
}
