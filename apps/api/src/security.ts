import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const SESSION_TTL_DAYS = 30;
const SESSION_IDLE_TTL_DAYS = 7;
export const PASSWORD_MIN_LENGTH = 10;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(token).digest("base64url");
}

export function createSessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function createSessionIdleExpiry(): Date {
  return new Date(Date.now() + SESSION_IDLE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("base64url");
}

export function isPasswordUsable(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= 128;
}
