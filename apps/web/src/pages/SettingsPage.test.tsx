import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../api";
import { UserSettingsPage } from "./SettingsPage";

describe("UserSettingsPage billing", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders past_due state and usage warning math", async () => {
    mockBillingFetch({ account: { plan: "pro", monthlyPriceEur: 29, subscriptionStatus: "past_due", currentPeriodEnd: "2026-07-31T00:00:00.000Z" } });

    renderBilling();

    expect(await screen.findByText("past due")).toBeInTheDocument();
    expect(screen.getByText(/Payment failed/)).toBeInTheDocument();
    expect(await screen.findByLabelText("Emails usage 80%")).toBeInTheDocument();
  });

  it("renders downgrade blocking resources from 409 checkout", async () => {
    mockBillingFetch({
      account: { plan: "scale", monthlyPriceEur: 99, subscriptionStatus: "active", currentPeriodEnd: "2026-07-31T00:00:00.000Z" },
      checkoutStatus: 409
    });

    renderBilling();

    fireEvent.click(await screen.findByRole("button", { name: "Downgrade" }));

    expect(await screen.findByText("Remove 2 agent identity before selecting pro.")).toBeInTheDocument();
  });

  it("renders plan grid from API data", async () => {
    mockBillingFetch();

    renderBilling();

    expect(await screen.findByText("Scale")).toBeInTheDocument();
    expect(screen.getByText("3 phone numbers")).toBeInTheDocument();
  });
});

function renderBilling() {
  return render(
    <UserSettingsPage
      user={user()}
      activeSection="billing"
      sites={[]}
      onSectionChange={vi.fn()}
      onUserUpdated={vi.fn()}
      onNotify={vi.fn()}
      onBack={vi.fn()}
      onLogout={vi.fn()}
    />
  );
}

function mockBillingFetch(input: {
  account?: Partial<ReturnType<typeof billingAccount>>;
  checkoutStatus?: number;
} = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = String(request);
    if (url.endsWith("/api/v1/billing")) return jsonResponse({ ...billingAccount(), ...(input.account ?? {}) });
    if (url.endsWith("/api/v1/billing/plans")) return jsonResponse({ plans });
    if (url.endsWith("/api/v1/billing/usage")) return jsonResponse(usage());
    if (url.endsWith("/api/v1/ops/email-domain")) return jsonResponse({ domain: domain() });
    if (url.endsWith("/api/v1/ops/status")) return jsonResponse(opsStatus());
    if (url.endsWith("/api/v1/billing/checkout") && init?.method === "POST") {
      return input.checkoutStatus === 409
        ? jsonResponse({ error: { code: "validation_failed", message: "current usage exceeds selected plan limits", details: { blocking: ["Remove 2 agent identity before selecting pro."] } }, message: "current usage exceeds selected plan limits" }, 409)
        : jsonResponse({ checkoutUrl: "https://stripe.test/checkout" });
    }
    if (url.endsWith("/api/v1/billing/portal")) return jsonResponse({ portalUrl: "https://stripe.test/portal" });
    return jsonResponse({ error: "not found" }, 404);
  });
}

function user(): User {
  return {
    id: "user_1",
    email: "owner@example.com",
    displayName: "Owner",
    avatarUrl: null,
    notificationPreferences: { productEmails: true, identityEmails: true, securityEmails: true },
    createdAt: "2026-07-07T00:00:00.000Z"
  };
}

function billingAccount() {
  return {
    plan: "pro",
    monthlyPriceEur: 29,
    subscriptionStatus: "active",
    currentPeriodEnd: "2026-07-31T00:00:00.000Z",
    includedUsage: { agents: 3, phoneNumbers: 1, emails: 500, callMinutes: 120, sms: 200 }
  };
}

const plans = [
  { plan: "free", name: "Free", monthlyPriceEur: 0, limits: { agents: 1, phoneNumbers: 0 }, features: { email: true, phone: false }, includedUsage: { emails: 50, callMinutes: 0, sms: 0 } },
  { plan: "pro", name: "Pro", monthlyPriceEur: 29, limits: { agents: 3, phoneNumbers: 1 }, features: { email: true, phone: true }, includedUsage: { emails: 500, callMinutes: 120, sms: 200 } },
  { plan: "scale", name: "Scale", monthlyPriceEur: 99, limits: { agents: 10, phoneNumbers: 3 }, features: { email: true, phone: true }, includedUsage: { emails: 2000, callMinutes: 600, sms: 1000 } }
];

function usage() {
  return {
    periodKey: "2026-07",
    plan: "pro",
    perMeter: {
      emails_sent: { used: 40, included: 50, overage: 0 },
      call_minutes: { used: 10, included: 120, overage: 0 },
      sms_messages: { used: 0, included: 200, overage: 0 },
      active_numbers: { used: 1, included: 1, overage: 0 }
    }
  };
}

function domain() {
  return { id: null, name: "agents.barkan.dev", status: "not_created", verified: false, records: [] };
}

function opsStatus() {
  return {
    providerModes: { email: "mock", phone: "mock", billing: "live" },
    emailDomainVerified: false,
    stripeWebhookLastSeenAt: "2026-07-07T12:00:00.000Z",
    twilioNumbers: 1
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
