import { Copy, KeyRound, Loader2, Mail, Phone, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { agentsApi } from "../api/agents";
import type { AgentDetailResponse, EmailPolicy, IdentityToken } from "../api/types";
import type { ToastNotificationInput } from "../components/ToastNotifications";
import { Brand, getErrorMessage, type SiteDetailTab } from "../legacy/shared";
import { BackChevronIcon, SiteSettingsCategoryIcon } from "./SettingsPage";

const pollIntervalMs = 3000;

export function AgentDetailPage({
  detail,
  activeTab,
  onAgentDetailLoaded,
  onAgentUpdated,
  onAgentDeleted,
  onTokensChanged,
  onNotify,
  onClose
}: {
  detail: AgentDetailResponse;
  activeTab: SiteDetailTab;
  onAgentDetailLoaded: (detail: AgentDetailResponse) => void;
  onAgentUpdated: (detail: AgentDetailResponse) => void;
  onAgentDeleted: (agentId: string) => void;
  onTokensChanged: (tokens: IdentityToken[]) => void;
  onNotify: (notification: ToastNotificationInput) => void;
  onClose: () => void;
}) {
  const { agent, tokens, provisioning } = detail;
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [newTokenSecret, setNewTokenSecret] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("runtime token");
  const [emailPolicy, setEmailPolicy] = useState<EmailPolicy | null>(null);
  const [emailPolicyDraft, setEmailPolicyDraft] = useState<EmailPolicy | null>(null);
  const [emailPolicyError, setEmailPolicyError] = useState("");
  const isProvisioning = provisioning.email.state === "pending" || provisioning.phone.state === "pending";

  useEffect(() => {
    if (!isProvisioning) return;
    const intervalId = window.setInterval(async () => {
      try {
        onAgentDetailLoaded(await agentsApi.get(agent.id));
      } catch {
        // Polling is best-effort; explicit actions surface errors.
      }
    }, pollIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [agent.id, isProvisioning, onAgentDetailLoaded]);

  async function refreshDetail() {
    const nextDetail = await agentsApi.get(agent.id);
    onAgentUpdated(nextDetail);
    return nextDetail;
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusyAction(label);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(getErrorMessage(actionError, "Action failed"));
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleCapability(capability: "email" | "phone", enabled: boolean) {
    if (!enabled) {
      const warning =
        capability === "phone"
          ? "Disable phone? This may release the phone number once live provisioning is enabled."
          : "Disable email for this agent identity?";
      if (!window.confirm(warning)) return;
    }
    await runAction(`${capability}-${enabled ? "enable" : "disable"}`, async () => {
      if (enabled) {
        await agentsApi.enableCapability(agent.id, capability);
      } else {
        await agentsApi.disableCapability(agent.id, capability);
      }
      onAgentDetailLoaded(await agentsApi.get(agent.id));
    });
  }

  async function createToken() {
    await runAction("token-create", async () => {
      const createdToken = await agentsApi.createToken(agent.id, tokenName.trim() || "runtime token");
      setNewTokenSecret(createdToken.secret);
      onTokensChanged([{ id: createdToken.id, name: createdToken.name, prefix: createdToken.prefix, status: "active", lastUsedAt: null, createdAt: new Date().toISOString() }, ...tokens]);
      onNotify({ title: "Identity token created" });
    });
  }

  async function revokeToken(tokenId: string) {
    await runAction(`token-${tokenId}`, async () => {
      await agentsApi.revokeToken(agent.id, tokenId);
      const nextDetail = await agentsApi.get(agent.id);
      onTokensChanged(nextDetail.tokens);
      onNotify({ title: "Identity token revoked" });
    });
  }

  async function pauseOrResume() {
    await runAction("status", async () => {
      const nextStatus = agent.status === "paused" ? "active" : "paused";
      await agentsApi.update(agent.id, { status: nextStatus });
      await refreshDetail();
      onNotify({ title: nextStatus === "paused" ? "Agent paused" : "Agent resumed" });
    });
  }

  async function deleteAgent() {
    const typedName = window.prompt(`Type ${agent.name} to delete this agent identity.`);
    if (typedName !== agent.name) return;
    await runAction("delete", async () => {
      await agentsApi.delete(agent.id);
      onAgentDeleted(agent.id);
      onNotify({ title: "Agent identity deleted" });
    });
  }

  const visibleTab = activeTab === "email" || activeTab === "phone" ? activeTab : "credentials";

  useEffect(() => {
    if (visibleTab !== "email") return;
    let cancelled = false;
    setEmailPolicyError("");
    void agentsApi.getEmailPolicy(agent.id)
      .then((response) => {
        if (cancelled) return;
        setEmailPolicy(response.policy);
        setEmailPolicyDraft(response.policy);
      })
      .catch((policyError) => {
        if (!cancelled) setEmailPolicyError(getErrorMessage(policyError, "Could not load email policy"));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, visibleTab]);

  async function saveEmailPolicy() {
    if (!emailPolicyDraft) return;
    await runAction("email-policy-save", async () => {
      const response = await agentsApi.updateEmailPolicy(agent.id, emailPolicyDraft);
      setEmailPolicy(response.policy);
      setEmailPolicyDraft(response.policy);
      onNotify({ title: "Email policy saved" });
    });
  }

  return (
    <section className="site-detail-page" aria-labelledby="agentDetailTitle">
      <aside className="site-detail-page__sidebar">
        <button className="site-detail-page__back" type="button" onClick={onClose}>
          <BackChevronIcon />
          <span>Back</span>
        </button>
        <Brand className="site-detail-page__brand" />
        <nav className="site-detail-page__tabs" role="tablist" aria-label="Agent detail">
          <DetailTab active={visibleTab === "credentials"} icon="general" label="Overview" />
          <DetailTab active={visibleTab === "email"} icon="email" label="Email" />
          <DetailTab active={visibleTab === "phone"} icon="phone" label="Phone" />
          <button className="site-detail-page__tab" type="button" disabled title="Controlled agent spending is on the roadmap">
            <SiteSettingsCategoryIcon icon="billing" />
            <span>Payment card</span>
            <small>Coming soon</small>
          </button>
        </nav>
      </aside>

      <div className="site-detail-page__content">
        <header className="site-detail-page__header">
          <div>
            <h1 id="agentDetailTitle">{agent.name}</h1>
            <p>{agent.description || "Agent identity linked to real-world tools."}</p>
          </div>
          <span className={`dashboard-page__project-pill dashboard-page__project-pill--${agent.status}`}>{agent.status}</span>
        </header>

        {error ? <p className="field-error" role="alert">{error}</p> : null}
        {visibleTab === "credentials" ? (
          <>
            <section className="site-detail-page__section">
              <h2>Contact points</h2>
              <ContactPoint label="Email" value={agent.emailAddress} icon={<Mail size={16} aria-hidden="true" />} />
              <ContactPoint label="Phone" value={agent.phoneE164} icon={<Phone size={16} aria-hidden="true" />} />
            </section>

            <section className="site-detail-page__section">
              <h2>Capabilities</h2>
              <CapabilityRow
                capability="email"
                enabled={agent.capabilities.email}
                isBusy={busyAction === "email-enable" || busyAction === "email-disable"}
                provisioning={provisioning.email}
                onToggle={toggleCapability}
              />
              <CapabilityRow
                capability="phone"
                enabled={agent.capabilities.phone}
                isBusy={busyAction === "phone-enable" || busyAction === "phone-disable"}
                provisioning={provisioning.phone}
                onToggle={toggleCapability}
              />
              <div className="site-detail-page__info-row">
                <span>Payment card</span>
                <strong>Coming soon</strong>
              </div>
            </section>

            <section className="site-detail-page__section">
              <div className="site-detail-page__section-heading">
                <h2>Identity tokens</h2>
                <KeyRound size={17} aria-hidden="true" />
              </div>
              {newTokenSecret ? (
                <div className="site-detail-panel__secret">
                  <code>{newTokenSecret}</code>
                  <button type="button" onClick={() => void copyText(newTokenSecret, onNotify)}>
                    <Copy size={15} aria-hidden="true" />
                    <span>Copy</span>
                  </button>
                </div>
              ) : null}
              <div className="site-detail-page__token-form">
                <input value={tokenName} onChange={(event) => setTokenName(event.target.value)} aria-label="Token name" />
                <button type="button" disabled={busyAction === "token-create"} onClick={() => void createToken()}>
                  {busyAction === "token-create" ? <Loader2 size={15} aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
                  <span>Create token</span>
                </button>
              </div>
              <div className="site-detail-page__token-list">
                {tokens.map((token) => (
                  <div className="site-detail-page__info-row" key={token.id}>
                    <span>{token.name} · {token.prefix}... · {token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : "never used"}</span>
                    <button type="button" disabled={token.status === "revoked" || busyAction === `token-${token.id}`} onClick={() => void revokeToken(token.id)}>
                      {token.status === "revoked" ? "Revoked" : "Revoke"}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="site-detail-page__section site-detail-page__section--danger">
              <h2>Danger zone</h2>
              <button type="button" onClick={() => void pauseOrResume()}>
                {agent.status === "paused" ? "Resume agent" : "Pause agent"}
              </button>
              <button type="button" onClick={() => void deleteAgent()}>
                <Trash2 size={15} aria-hidden="true" />
                <span>Delete agent identity</span>
              </button>
            </section>
          </>
        ) : visibleTab === "email" ? (
          <section className="site-detail-page__section">
            <div className="site-detail-page__section-heading">
              <h2>Email policy</h2>
              <Mail size={17} aria-hidden="true" />
            </div>
            {emailPolicyError ? <p className="field-error" role="alert">{emailPolicyError}</p> : null}
            {emailPolicyDraft ? (
              <EmailPolicyEditor
                policy={emailPolicyDraft}
                savedPolicy={emailPolicy}
                isSaving={busyAction === "email-policy-save"}
                onChange={setEmailPolicyDraft}
                onSave={saveEmailPolicy}
              />
            ) : (
              <div className="site-detail-page__info-row"><span>Email policy</span><strong>Loading</strong></div>
            )}
          </section>
        ) : (
          <section className="site-detail-page__section">
            <h2>Phone</h2>
            <p>Phone panel lands in task 029.</p>
          </section>
        )}
      </div>
    </section>
  );
}

function EmailPolicyEditor({
  policy,
  savedPolicy,
  isSaving,
  onChange,
  onSave
}: {
  policy: EmailPolicy;
  savedPolicy: EmailPolicy | null;
  isSaving: boolean;
  onChange: (policy: EmailPolicy) => void;
  onSave: () => Promise<void>;
}) {
  const isDirty = JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  return (
    <div className="agent-email-policy">
      <div className="agent-email-policy__modes" role="radiogroup" aria-label="Email approval mode">
        {[
          ["always", "Always"],
          ["new_recipients", "New"],
          ["never", "Never"]
        ].map(([value, label]) => (
          <label key={value} className="agent-email-policy__mode">
            <input
              type="radio"
              name="email-approval-mode"
              value={value}
              checked={policy.requireApproval === value}
              onChange={() => onChange({ ...policy, requireApproval: value as EmailPolicy["requireApproval"] })}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <label className="site-detail-page__field">
        <span>Allowed recipients</span>
        <input
          value={formatPatterns(policy.allowedRecipients)}
          onChange={(event) => onChange({ ...policy, allowedRecipients: parsePatterns(event.target.value) })}
          placeholder="alice@example.com, @example.com"
        />
      </label>
      <PolicyChips values={policy.allowedRecipients} />

      <label className="site-detail-page__field">
        <span>Blocked recipients</span>
        <input
          value={formatPatterns(policy.blockedRecipients)}
          onChange={(event) => onChange({ ...policy, blockedRecipients: parsePatterns(event.target.value) })}
          placeholder="blocked@example.com, @competitor.com"
        />
      </label>
      <PolicyChips values={policy.blockedRecipients} tone="danger" />

      <div className="agent-email-policy__numbers">
        <label className="site-detail-page__field">
          <span>Daily limit</span>
          <input
            type="number"
            min={0}
            max={10000}
            value={policy.dailySendLimit}
            onChange={(event) => onChange({ ...policy, dailySendLimit: Number(event.target.value) })}
          />
        </label>
        <label className="site-detail-page__field">
          <span>Recipients per message</span>
          <input
            type="number"
            min={1}
            max={50}
            value={policy.maxRecipientsPerMessage}
            onChange={(event) => onChange({ ...policy, maxRecipientsPerMessage: Number(event.target.value) })}
          />
        </label>
      </div>

      <button className="site-detail-page__save" type="button" disabled={!isDirty || isSaving} onClick={() => void onSave()}>
        {isSaving ? <Loader2 size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
        <span>Save policy</span>
      </button>
    </div>
  );
}

function PolicyChips({ values, tone }: { values: string[]; tone?: "danger" }) {
  if (!values.length) return null;
  return (
    <div className="agent-email-policy__chips">
      {values.map((value) => (
        <span className={tone === "danger" ? "agent-email-policy__chip agent-email-policy__chip--danger" : "agent-email-policy__chip"} key={value}>{value}</span>
      ))}
    </div>
  );
}

function parsePatterns(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function formatPatterns(values: string[]): string {
  return values.join(", ");
}

function DetailTab({ active, icon, label }: { active: boolean; icon: "general" | "email" | "phone"; label: string }) {
  return (
    <button className="site-detail-page__tab" type="button" role="tab" aria-selected={active}>
      <SiteSettingsCategoryIcon icon={icon} />
      <span>{label}</span>
    </button>
  );
}

function ContactPoint({ icon, label, value }: { icon: ReactNode; label: string; value: string | null }) {
  return (
    <div className="site-detail-page__info-row">
      <span>{icon}{label}</span>
      {value ? (
        <button type="button" onClick={() => void navigator.clipboard.writeText(value)}>
          <strong>{value}</strong>
          <Copy size={14} aria-hidden="true" />
        </button>
      ) : (
        <strong>Not provisioned</strong>
      )}
    </div>
  );
}

function CapabilityRow({
  capability,
  enabled,
  isBusy,
  provisioning,
  onToggle
}: {
  capability: "email" | "phone";
  enabled: boolean;
  isBusy: boolean;
  provisioning: AgentDetailResponse["provisioning"]["email"];
  onToggle: (capability: "email" | "phone", enabled: boolean) => Promise<void>;
}) {
  return (
    <div className="site-detail-page__info-row">
      <span>{capability === "email" ? "Email" : "Phone"}</span>
      <label className="user-settings-page__toggle">
        <input
          type="checkbox"
          aria-label={`Enable ${capability}`}
          checked={enabled}
          disabled={isBusy}
          onChange={(event) => void onToggle(capability, event.target.checked)}
        />
        <span className="user-settings-page__toggle-control" aria-hidden="true" />
        <span>
          <strong>{provisioning.state}</strong>
          <small>{provisioning.detail || (enabled ? "Enabled" : "Off")}</small>
        </span>
      </label>
    </div>
  );
}

async function copyText(value: string, onNotify: (notification: ToastNotificationInput) => void) {
  await navigator.clipboard.writeText(value);
  onNotify({ title: "Copied" });
}
