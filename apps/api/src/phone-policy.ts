import type { PhonePolicy } from "./db.js";
import { countryAllowedByPolicy } from "./lib/phone-country.js";

export function enforcePhoneCountry(policy: PhonePolicy, e164: string): { ok: true } | { ok: false; reason: string } {
  const decision = countryAllowedByPolicy(e164, policy.allowedCountries);
  return decision.allowed ? { ok: true } : { ok: false, reason: decision.reason };
}

export function quietHoursBlockReason(policy: PhonePolicy, now = new Date()): string | null {
  if (!policy.quietHours) return null;
  const currentMinute = localMinuteOfDay(now, policy.quietHours.timezone);
  const start = parseClock(policy.quietHours.start);
  const end = parseClock(policy.quietHours.end);
  const blocked = start <= end
    ? currentMinute >= start && currentMinute < end
    : currentMinute >= start || currentMinute < end;
  return blocked ? `quiet hours are active in ${policy.quietHours.timezone}` : null;
}

export function startOfPolicyDay(policy: PhonePolicy, now = new Date()): Date {
  const timezone = policy.quietHours?.timezone ?? "UTC";
  const parts = datePartsInZone(now, timezone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timezone);
}

function parseClock(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function localMinuteOfDay(value: Date, timezone: string): number {
  const parts = datePartsInZone(value, timezone);
  return parts.hour * 60 + parts.minute;
}

function datePartsInZone(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second)
  };
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): Date {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const offset = timeZoneOffsetMs(utc, timezone);
    utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset);
  }
  return utc;
}

function timeZoneOffsetMs(value: Date, timezone: string): number {
  const parts = datePartsInZone(value, timezone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - value.getTime();
}
