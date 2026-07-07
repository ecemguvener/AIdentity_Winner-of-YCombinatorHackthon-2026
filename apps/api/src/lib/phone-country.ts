import { normalizeE164PhoneNumber } from "./phone.js";

const countryPrefixes = [
  ["1", "US"],
  ["33", "FR"],
  ["44", "GB"],
  ["49", "DE"],
  ["39", "IT"],
  ["34", "ES"],
  ["31", "NL"],
  ["32", "BE"],
  ["41", "CH"],
  ["43", "AT"],
  ["45", "DK"],
  ["46", "SE"],
  ["47", "NO"],
  ["358", "FI"],
  ["353", "IE"],
  ["351", "PT"],
  ["30", "GR"],
  ["48", "PL"],
  ["420", "CZ"],
  ["36", "HU"],
  ["40", "RO"],
  ["359", "BG"],
  ["385", "HR"],
  ["386", "SI"],
  ["421", "SK"],
  ["370", "LT"],
  ["371", "LV"],
  ["372", "EE"],
  ["352", "LU"],
  ["356", "MT"],
  ["357", "CY"],
  ["61", "AU"],
  ["64", "NZ"],
  ["81", "JP"],
  ["82", "KR"],
  ["91", "IN"],
  ["55", "BR"],
  ["52", "MX"]
] satisfies Array<[string, string]>;

countryPrefixes.sort((a, b) => b[0].length - a[0].length);

export function countryIsoForE164(value: string): string | null {
  const normalized = normalizeE164PhoneNumber(value);
  if (!normalized) return null;
  const digits = normalized.slice(1);
  return countryPrefixes.find(([prefix]) => digits.startsWith(prefix))?.[1] ?? null;
}

export function countryAllowedByPolicy(value: string, allowedCountries: string[]): { allowed: true; country: string | null } | { allowed: false; country: string | null; reason: string } {
  const normalizedAllowedCountries = allowedCountries.map((country) => country.trim().toUpperCase()).filter(Boolean);
  if (normalizedAllowedCountries.length === 0) {
    return { allowed: true, country: countryIsoForE164(value) };
  }
  const country = countryIsoForE164(value);
  if (!country) {
    return { allowed: false, country: null, reason: "unknown country is not allowed by phone policy" };
  }
  if (!normalizedAllowedCountries.includes(country)) {
    return { allowed: false, country, reason: `country ${country} not allowed by phone policy` };
  }
  return { allowed: true, country };
}
