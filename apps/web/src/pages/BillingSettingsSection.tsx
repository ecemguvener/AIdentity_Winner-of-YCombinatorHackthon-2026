import { Copy, ExternalLink, Loader2 } from "lucide-react";
import type {
  BillingAccountView,
  BillingPlanName,
  BillingPlanView,
  BillingUsageView,
  EmailDomainStatusView,
  OpsStatusView,
  UsageMeter
} from "../api/billing";

export function BillingSettingsContent({
  isLoading,
  error,
  account,
  plans,
  usage,
  emailDomain,
  opsStatus,
  billingBlocks,
  onPortal,
  onChoosePlan,
  onCopyRecord
}: {
  isLoading: boolean;
  error: string;
  account: BillingAccountView | null;
  plans: BillingPlanView[];
  usage: BillingUsageView | null;
  emailDomain: EmailDomainStatusView | null;
  opsStatus: OpsStatusView | null;
  billingBlocks: string[];
  onPortal: () => void;
  onChoosePlan: (plan: BillingPlanName) => void;
  onCopyRecord: (record: EmailDomainStatusView["records"][number]) => void;
}) {
  return (
    <>
      {isLoading && !account ? (
        <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush">
          <div className="billing-page__loading"><Loader2 size={18} aria-hidden="true" /> Loading billing</div>
        </section>
      ) : null}
      {error ? <p className="site-detail-panel__error">{error}</p> : null}
      {account ? <BillingCurrentPlan account={account} onPortal={onPortal} /> : null}
      {billingBlocks.length > 0 ? (
        <section className="billing-page__blocking" aria-label="Plan change blockers">
          {billingBlocks.map((block) => <p key={block}>{block}</p>)}
        </section>
      ) : null}
      {plans.length > 0 && account ? (
        <BillingPlanGrid plans={plans} currentPlan={account.plan} onChoose={onChoosePlan} />
      ) : null}
      {usage ? <BillingUsageSection usage={usage} /> : null}
      {opsStatus && emailDomain ? (
        <BillingOpsSection status={opsStatus} domain={emailDomain} onCopyRecord={onCopyRecord} />
      ) : null}
    </>
  );
}

function BillingCurrentPlan({ account, onPortal }: { account: BillingAccountView; onPortal: () => void }) {
  const status = account.subscriptionStatus ?? (account.plan === "free" ? "free" : "active");
  const isPastDue = status === "past_due";
  return (
    <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush billing-current-plan">
      <div className="site-detail-page__section-heading">
        <div>
          <h3>{planLabel(account.plan)} plan</h3>
          <p>{account.monthlyPriceEur === 0 ? "Free" : `€${account.monthlyPriceEur}/mo`} · {account.currentPeriodEnd ? `Renews ${formatBillingDate(account.currentPeriodEnd)}` : "No renewal date"}</p>
        </div>
        <span className={`billing-status-pill${isPastDue ? " billing-status-pill--warning" : ""}`}>{status.replace(/_/g, " ")}</span>
      </div>
      {isPastDue ? <p className="billing-page__warning">Payment failed. Update payment method to keep paid capabilities active.</p> : null}
      <div className="user-settings-page__metric-grid">
        <UserSettingsMetric label="Identities" value={account.includedUsage.agents} />
        <UserSettingsMetric label="Phone numbers" value={account.includedUsage.phoneNumbers} />
        <UserSettingsMetric label="Monthly emails" value={account.includedUsage.emails} />
      </div>
      <div className="billing-page__actions">
        <button className="site-detail-page__section-action" type="button" onClick={onPortal}>
          <ExternalLink size={14} aria-hidden="true" />
          Manage payment method & invoices
        </button>
      </div>
      {account.subscriptionStatus === "canceled" ? <p className="billing-page__note">Subscription canceled. Account stays on current access until period end.</p> : null}
    </section>
  );
}

function BillingPlanGrid({
  plans,
  currentPlan,
  onChoose
}: {
  plans: BillingPlanView[];
  currentPlan: BillingPlanName;
  onChoose: (plan: BillingPlanName) => void;
}) {
  return (
    <section className="site-detail-panel__api-key site-detail-page__section billing-plan-grid">
      <div className="site-detail-page__section-heading">
        <div>
          <h3>Plans</h3>
          <p>Limits and included usage come from the billing API.</p>
        </div>
      </div>
      <div className="billing-plan-grid__cards">
        {plans.map((plan) => {
          const isCurrent = plan.plan === currentPlan;
          return (
            <article key={plan.plan} className={`billing-plan-card${isCurrent ? " billing-plan-card--current" : ""}`}>
              <header>
                <h4>{plan.name}</h4>
                <strong>{plan.monthlyPriceEur === 0 ? "Free" : `€${plan.monthlyPriceEur}/mo`}</strong>
              </header>
              <ul>
                <li>{plan.limits.agents} agent identities</li>
                <li>{plan.limits.phoneNumbers} phone numbers</li>
                <li>{plan.includedUsage.emails} emails included</li>
                <li>{plan.includedUsage.callMinutes} call minutes</li>
                <li>{plan.includedUsage.sms} SMS</li>
                <li>{plan.features.phone ? "Phone enabled" : "No phone access"}</li>
              </ul>
              <button className="site-detail-page__section-action" type="button" disabled={isCurrent || plan.plan === "free"} onClick={() => onChoose(plan.plan)}>
                {isCurrent ? "Current plan" : plan.plan === "free" ? "Included" : plan.monthlyPriceEur > priceForPlan(currentPlan, plans) ? "Upgrade" : "Downgrade"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function BillingUsageSection({ usage }: { usage: BillingUsageView }) {
  const meters: Array<{ meter: UsageMeter; label: string; unitCost: number }> = [
    { meter: "emails_sent", label: "Emails", unitCost: 0.01 },
    { meter: "call_minutes", label: "Call minutes", unitCost: 0.12 },
    { meter: "sms_messages", label: "SMS", unitCost: 0.04 },
    { meter: "active_numbers", label: "Active numbers", unitCost: 1.15 }
  ];
  return (
    <section className="site-detail-panel__api-key site-detail-page__section billing-usage">
      <div className="site-detail-page__section-heading">
        <div>
          <h3>Usage</h3>
          <p>Current period {usage.periodKey}</p>
        </div>
      </div>
      <div className="billing-usage__rows">
        {meters.map(({ meter, label, unitCost }) => {
          const row = usage.perMeter[meter];
          const percent = row.included > 0 ? Math.min(100, Math.round((row.used / row.included) * 100)) : row.used > 0 ? 100 : 0;
          const projectedCost = row.overage * unitCost;
          return (
            <div key={meter} className="billing-usage__row">
              <div>
                <strong>{label}</strong>
                <span>{row.used} / {row.included} included{row.overage > 0 ? ` · ${row.overage} over · €${projectedCost.toFixed(2)}` : ""}</span>
              </div>
              <div className={`billing-usage__bar${percent >= 80 ? " billing-usage__bar--warning" : ""}`} aria-label={`${label} usage ${percent}%`}>
                <span style={{ width: `${percent}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BillingOpsSection({
  status,
  domain,
  onCopyRecord
}: {
  status: OpsStatusView;
  domain: EmailDomainStatusView;
  onCopyRecord: (record: EmailDomainStatusView["records"][number]) => void;
}) {
  const missingRecords = domain.records.filter((record) => record.status !== "verified");
  return (
    <section className="site-detail-panel__api-key site-detail-page__section billing-ops">
      <div className="site-detail-page__section-heading">
        <div>
          <h3>Platform status</h3>
          <p>{domain.name} DNS {status.emailDomainVerified ? "verified" : "needs attention"}</p>
        </div>
      </div>
      <div className="user-settings-page__metric-grid">
        <UserSettingsMetric label="Email provider" value={status.providerModes.email} />
        <UserSettingsMetric label="Phone provider" value={status.providerModes.phone} />
        <UserSettingsMetric label="Billing provider" value={status.providerModes.billing} />
        <UserSettingsMetric label="Twilio numbers" value={status.twilioNumbers} />
      </div>
      <p className="billing-page__note">Stripe webhook: {status.stripeWebhookLastSeenAt ? formatBillingDate(status.stripeWebhookLastSeenAt) : "No events yet"}</p>
      {missingRecords.length > 0 ? (
        <div className="billing-dns-records">
          {missingRecords.map((record) => (
            <button key={`${record.type}-${record.name}-${record.value}`} type="button" onClick={() => onCopyRecord(record)}>
              <span>{record.type} {record.name}</span>
              <small>{record.value}</small>
              <Copy size={14} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function UserSettingsMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="user-settings-page__metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function planLabel(plan: BillingPlanName): string {
  return plan === "free" ? "Free" : plan === "pro" ? "Pro" : "Scale";
}

function priceForPlan(plan: BillingPlanName, plans: BillingPlanView[]): number {
  return plans.find((item) => item.plan === plan)?.monthlyPriceEur ?? 0;
}

function formatBillingDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
