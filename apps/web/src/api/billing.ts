import { requestJson } from "./client";

export type BillingPlanName = "free" | "pro" | "scale";

export interface BillingAccountView {
  plan: BillingPlanName;
  monthlyPriceEur: number;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  includedUsage: {
    agents: number;
    phoneNumbers: number;
    emails: number;
    callMinutes: number;
    sms: number;
  };
}

export interface BillingPlanView {
  plan: BillingPlanName;
  name: string;
  monthlyPriceEur: number;
  limits: {
    agents: number;
    phoneNumbers: number;
  };
  features: {
    email: boolean;
    phone: boolean;
  };
  includedUsage: {
    emails: number;
    callMinutes: number;
    sms: number;
  };
}

export type UsageMeter = "emails_sent" | "call_minutes" | "sms_messages" | "active_numbers";

export interface BillingUsageView {
  periodKey: string;
  plan: BillingPlanName;
  perMeter: Record<UsageMeter, { used: number; included: number; overage: number }>;
}

export interface EmailDomainRecordView {
  record: string;
  type: string;
  name: string;
  value: string;
  status: string;
  priority?: number;
}

export interface EmailDomainStatusView {
  id: string | null;
  name: string;
  status: string;
  verified: boolean;
  records: EmailDomainRecordView[];
}

export interface OpsStatusView {
  providerModes: {
    email: "live" | "mock";
    phone: "live" | "mock";
    billing: "live" | "mock";
  };
  emailDomainVerified: boolean;
  stripeWebhookLastSeenAt: string | null;
  twilioNumbers: number;
}

export const billingApi = {
  getAccount: () => requestJson<BillingAccountView>("/api/v1/billing"),
  getPlans: () => requestJson<{ plans: BillingPlanView[] }>("/api/v1/billing/plans"),
  getUsage: () => requestJson<BillingUsageView>("/api/v1/billing/usage"),
  checkout: (plan: Exclude<BillingPlanName, "free">) =>
    requestJson<{ checkoutUrl: string }>("/api/v1/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan })
    }),
  portal: () => requestJson<{ portalUrl: string }>("/api/v1/billing/portal", { method: "POST" }),
  getEmailDomain: () => requestJson<{ domain: EmailDomainStatusView }>("/api/v1/ops/email-domain"),
  getOpsStatus: () => requestJson<OpsStatusView>("/api/v1/ops/status")
};
