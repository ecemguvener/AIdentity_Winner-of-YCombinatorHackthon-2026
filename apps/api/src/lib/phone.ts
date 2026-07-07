export function normalizeE164PhoneNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^00/, "+")
    .replace(/[^\d+]/g, "")
    .replace(/(?!^)\+/g, "");

  if (/^\+\d{7,15}$/.test(normalized)) {
    return normalized;
  }

  if (/^\d{7,15}$/.test(normalized)) {
    return `+${normalized}`;
  }

  return null;
}
