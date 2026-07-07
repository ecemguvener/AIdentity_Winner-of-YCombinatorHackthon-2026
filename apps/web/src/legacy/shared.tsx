import { CalendarDays, Mail, Phone } from "lucide-react";
import React, { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type FormEvent, type ReactNode } from "react";
export type { ToastNotificationInput } from "../components/ToastNotifications";
import {
  api,
  type DashboardChatCallEmbed,
  type DashboardChatMessageInput,
  type Site,
  type User
} from "../api";
import barkanMarkDark from "../assets/barkan/brand/barkan-mark-dark.svg";
import barkanMarkLight from "../assets/barkan/brand/barkan-mark-light.svg";
import sitePreviewAgentIdentities from "../assets/barkan/images/site-preview-agent-identities.jpg";
import sitePreviewConnectOpenClaw from "../assets/barkan/images/site-preview-connect-openclaw.jpg";
import sitePreviewIdentityReady from "../assets/barkan/images/site-preview-identity-ready.jpg";

export const dashboardPath = "/agents";
export const dashboardChatPath = `${dashboardPath}/chat`;
export const userSettingsPath = `${dashboardPath}/settings`;
export const approvalsPath = "/approvals";
export const newSitePath = "/agents/new";
export const signinPath = "/signin";
export const plansPath = "/plans";
export const profileAvatarMaxBytes = 256 * 1024;
export const profileAvatarAcceptedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type AuthMode = "login" | "signup";
export type AuthStep = "email" | "password";
export type SiteOnboardingStep = "name" | "openclaw" | "setup" | "install" | "finish";
export type OpenClawConnectionMode = "existing" | "deploy";
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
export type SetupProgressStep = "connection";
export type SetupStepProgress = Partial<Record<SetupProgressStep, { current: number; total: number; label?: string }>>;
export type StepTransition = {
  from: SiteOnboardingStep;
  to: SiteOnboardingStep;
};
export type AuthTransition = {
  from: AuthStep;
  to: AuthStep;
};

export const siteProgressSteps = [0, 1, 2, 3, 4];
export const siteStepIndexes: Record<SiteOnboardingStep, number> = {
  name: 0,
  openclaw: 1,
  setup: 2,
  install: 3,
  finish: 4
};
export const panelTransitionDurationMs = 560;
export const onboardingPanelTransitionDurationMs = 820;
export const onboardingPanelTransitionSwapMs = 300;
export const buttonLoadingDurationMs = 420;
export const requiredFieldMessage = "Please fill in this field.";
export const onboardingSetupSteps: Array<{ id: SetupProgressStep; label: string }> = [
  { id: "connection", label: "OpenClaw link" }
];

export function isCompletionOnboardingStep(step: SiteOnboardingStep) {
  return step === "setup" || step === "install" || step === "finish";
}
export const sitePreviewImages = {
  "site-preview-blue-flow": sitePreviewConnectOpenClaw,
  "site-preview-coral-mint": sitePreviewAgentIdentities,
  "site-preview-cyan-mist": sitePreviewIdentityReady,
  "site-preview-dashboard": sitePreviewConnectOpenClaw,
  "site-preview-lime-blue": sitePreviewAgentIdentities
} as const;
export const sitePreviewImageNames = Object.keys(sitePreviewImages) as Array<keyof typeof sitePreviewImages>;
export const agentIdentityCapabilities = [
  {
    label: "Phone",
    value: "+1 (415) 555-0198",
    description: "Calls and SMS for the agent",
    Icon: Phone
  },
  {
    label: "Email",
    value: "agent@identity.barkan.dev",
    description: "Inbox and outbound email identity",
    Icon: Mail
  },
  {
    label: "Calendar",
    value: "Managed calendar",
    description: "Availability and scheduling",
    Icon: CalendarDays
  }
] as const;

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

export function isTimeoutLikeSetupError(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  return normalizedMessage === "failed to fetch" || normalizedMessage.includes("time");
}

export function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

export function slugifyIdentityName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "agent";
}

export function buildOpenClawLinkPrompt(identityName: string, token: string | undefined, projectId: string | null): string {
  const linkEndpoint = `${window.location.origin}/api/openclaw/link/confirm`;
  const safeToken = token ?? "LINK_TOKEN_PENDING";
  const safeProjectId = projectId ?? "PROJECT_ID_PENDING";

  return `Install the Barkan Agent Identity skill for this OpenClaw instance.

Identity name: ${identityName.trim() || "New agent identity"}
Link endpoint: ${linkEndpoint}
Project token: ${safeProjectId}
Confirmation token: ${safeToken}

After installing the skill, call the link endpoint with the confirmation token so Barkan can attach this OpenClaw instance to the identity. Once linked, use the provisioned phone number, email inbox, calendar, and future real-world tools through the Barkan identity layer.`;
}

export function buildIdentityReceipt(site: Site | null): string {
  const identityName = site?.name ?? "Agent identity";
  const endpoint = site?.domain ?? "managed-openclaw.barkan.dev";

  return `Barkan Agent Identity
name=${identityName}
openclaw=${endpoint}
phone=+1-415-555-0198
email=agent@identity.barkan.dev
calendar=managed`;
}

export function isAppRoute(path: string): boolean {
  return isProtectedAppRoute(path) || isSigninRoute(path);
}

export function isProtectedAppRoute(path: string): boolean {
  return (
    isDashboardRoute(path) ||
    isDashboardChatRoute(path) ||
    isApprovalsRoute(path) ||
    isUserSettingsRoute(path) ||
    isNewSiteRoute(path) ||
    getSiteDetailRoute(path) !== null
  );
}

export function isDashboardRoute(path: string): boolean {
  return path === "/" || path === dashboardPath || path === `${dashboardPath}/`;
}

export function isDashboardChatRoute(path: string): boolean {
  return path === dashboardChatPath || path === `${dashboardChatPath}/`;
}

export function isUserSettingsRoute(path: string): boolean {
  return path === userSettingsPath || path === `${userSettingsPath}/`;
}

export function isApprovalsRoute(path: string): boolean {
  return path === approvalsPath || path === `${approvalsPath}/`;
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

export function getSiteDetailPath(siteId: string, tab: SiteDetailTab = "credentials"): string {
  return `/agents/${encodeURIComponent(siteId)}?tab=${tab}`;
}

export function getUserSettingsPath(section: UserSettingsSection = "profile"): string {
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
  if (isNewSiteRoute(path) || isDashboardChatRoute(path) || isApprovalsRoute(path) || isUserSettingsRoute(path) || isDashboardRoute(path)) {
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

  const rawSection = new URLSearchParams(search).get("section");
  if (rawSection === "security" || rawSection === "notifications" || rawSection === "billing") {
    return rawSection;
  }

  return "profile";
}

export function getStaggerStyle(index: number): CSSProperties {
  return { "--stagger-index": index } as CSSProperties;
}

export function getProjectCardStyle(index: number): CSSProperties {
  return { "--project-index": index } as CSSProperties;
}

export function getSitePreviewImage(site: Site): string {
  if (site.previewImage && site.previewImage in sitePreviewImages) {
    return sitePreviewImages[site.previewImage as keyof typeof sitePreviewImages];
  }

  let hash = 0;
  for (const character of site.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return sitePreviewImages[sitePreviewImageNames[hash % sitePreviewImageNames.length] ?? "site-preview-dashboard"];
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

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) {
    return null;
  }

  return (
    <p className="field-error" id={id} role="alert">
      {message}
    </p>
  );
}
