import React, { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type FormEvent, type ReactNode } from "react";
export type { ToastNotificationInput } from "./components/ToastNotifications";
import {
  api,
  type DashboardChatCallEmbed,
  type DashboardChatMessageInput,
  type User
} from "./api";
import barkanMarkDark from "./assets/barkan/brand/barkan-mark-dark.svg";

export const dashboardPath = "/agents";
export const dashboardChatPath = `${dashboardPath}/chat`;
const userSettingsPath = `${dashboardPath}/settings`;
const billingSettingsPath = "/settings/billing";
export const approvalsPath = "/approvals";
export const newSitePath = "/agents/new";
const pairPath = "/pair";
export const signinPath = "/signin";
export const plansPath = "/plans";
export const docsSitePath = "/docs-site";
export const profileAvatarMaxBytes = 256 * 1024;
export const profileAvatarAcceptedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type AuthMode = "login" | "signup";
export type AuthStep = "email" | "password";
export type DashboardSection = "sites" | "chat" | "approvals" | "settings";
export type DashboardChatRole = "assistant" | "user";
export type DashboardChatMessage = {
  id: string;
  role: DashboardChatRole;
  content: string;
  presentation?: "normal" | "activity";
  callEmbed?: DashboardChatCallEmbed & { state: "in_progress" | "completed" };
  clarificationDetails?: {
    entries: Array<{ question: string; answer: string }>;
  };
};
export type SiteDetailTab = "credentials" | "openclaw" | "phone" | "email";
export type UserSettingsSection = "profile" | "security" | "notifications" | "billing";
export type PanelState = "active" | "hidden" | "incoming" | "outgoing";
export type AuthTransition = {
  from: AuthStep;
  to: AuthStep;
};

export const panelTransitionDurationMs = 560;
export const requiredFieldMessage = "Please fill in this field.";

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

export function isAppRoute(path: string): boolean {
  return isProtectedAppRoute(path) || isSigninRoute(path);
}

export function isProtectedAppRoute(path: string): boolean {
  return (
    isDashboardRoute(path) ||
    isDashboardChatRoute(path) ||
    isApprovalsRoute(path) ||
    isPairRoute(path) ||
    isUserSettingsRoute(path) ||
    isNewSiteRoute(path) ||
    getSiteDetailRoute(path) !== null
  );
}

function isDashboardRoute(path: string): boolean {
  return path === dashboardPath || path === `${dashboardPath}/`;
}

export function isDashboardChatRoute(path: string): boolean {
  return path === dashboardChatPath || path === `${dashboardChatPath}/`;
}

export function isUserSettingsRoute(path: string): boolean {
  return path === userSettingsPath || path === `${userSettingsPath}/` || path === billingSettingsPath || path === `${billingSettingsPath}/`;
}

export function isApprovalsRoute(path: string): boolean {
  return path === approvalsPath || path === `${approvalsPath}/`;
}

export function isPairRoute(path: string): boolean {
  return path === pairPath || path === `${pairPath}/`;
}

export function isNewSiteRoute(path: string): boolean {
  return path === newSitePath || path === `${newSitePath}/`;
}

export function isSigninRoute(path: string): boolean {
  return path === signinPath || path === `${signinPath}/`;
}

export function isPlansRoute(path: string): boolean {
  return path === plansPath || path === `${plansPath}/`;
}

export function isDocsSiteRoute(path: string): boolean {
  return path === docsSitePath || path === `${docsSitePath}/` || path.startsWith(`${docsSitePath}/`);
}

export function getSiteDetailPath(siteId: string, tab: SiteDetailTab = "credentials"): string {
  return `/agents/${encodeURIComponent(siteId)}?tab=${tab}`;
}

export function getUserSettingsPath(section: UserSettingsSection = "profile"): string {
  if (section === "billing") return billingSettingsPath;
  return `${userSettingsPath}?section=${section}`;
}

export function getCurrentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function navigateToPublicHome() {
  if (import.meta.env.MODE === "test") {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }

  window.location.assign("/");
}

export function getSiteDetailRoute(path: string, search = ""): { siteId: string; tab: SiteDetailTab } | null {
  if (isNewSiteRoute(path) || isDashboardChatRoute(path) || isApprovalsRoute(path) || isPairRoute(path) || isUserSettingsRoute(path) || isDashboardRoute(path)) {
    return null;
  }

  const match = /^\/agents\/([^/]+)\/?$/.exec(path);
  if (!match) {
    return null;
  }

  const rawTab = new URLSearchParams(search).get("tab");
  const tab =
    rawTab === "openclaw" ||
    rawTab === "phone" ||
    rawTab === "email"
      ? rawTab
      : "credentials";

  try {
    return {
      siteId: decodeURIComponent(match[1]),
      tab
    };
  } catch {
    return null;
  }
}

export function getUserSettingsSection(path: string, search = ""): UserSettingsSection {
  if (!isUserSettingsRoute(path)) {
    return "profile";
  }
  if (path === billingSettingsPath || path === `${billingSettingsPath}/`) {
    return "billing";
  }

  const rawSection = new URLSearchParams(search).get("section");
  if (rawSection === "security" || rawSection === "notifications" || rawSection === "billing") {
    return rawSection;
  }

  return "profile";
}

export function getProjectCardStyle(index: number): CSSProperties {
  return { "--project-index": index } as CSSProperties;
}

export function formatSiteRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Recently updated";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return "Updated just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Updated ${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Updated ${elapsedDays}d ago`;
}

export function Brand({
  className = "",
  label = "Barkan",
  theme = "light"
}: {
  className?: string;
  label?: string;
  theme?: "light" | "dark";
}) {
  const markSrc = barkanMarkDark;

  return (
    <div className={`barkan-brand barkan-brand--${theme} ${className}`} aria-label={label}>
      <img className="barkan-brand__mark" src={markSrc} alt="" aria-hidden="true" />
      <span className="barkan-brand__name">{label}</span>
    </div>
  );
}

interface FloatingFieldProps {
  autoComplete?: string;
  errorMessage?: string;
  inputMode?: React.InputHTMLAttributes<HTMLInputElement>["inputMode"];
  label: string;
  minLength?: number;
  name: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: React.HTMLInputTypeAttribute;
  value: string;
}

export const FloatingField = React.forwardRef<HTMLInputElement, FloatingFieldProps>(function FloatingField(
  {
    autoComplete,
    errorMessage,
    inputMode,
    label,
    minLength,
    name,
    onChange,
    placeholder,
    type = "text",
    value
  },
  ref
) {
  const [isFocused, setIsFocused] = useState(false);
  const errorId = useId();
  const hasError = Boolean(errorMessage);
  const isFloating = hasError || isFocused || value.length > 0;
  const state = hasError ? "error" : isFloating ? "focused" : "idle";

  return (
    <div className={`floating-field floating-field--${state}`}>
      <div className="floating-field__shell">
        <label className="floating-field__label" htmlFor={name}>
          <span>{label}</span>
        </label>
        <input
          ref={ref}
          id={name}
          name={name}
          type={type}
          inputMode={inputMode}
          autoComplete={autoComplete}
          aria-invalid={hasError}
          aria-describedby={hasError ? errorId : undefined}
          aria-required="true"
          minLength={minLength}
          placeholder={placeholder}
          value={value}
          onBlur={() => setIsFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setIsFocused(true)}
          required
        />
      </div>
      {hasError ? <FieldError id={errorId} message={errorMessage} /> : null}
    </div>
  );
});

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="field-error" id={id} role="alert">
      {message}
    </p>
  );
}
