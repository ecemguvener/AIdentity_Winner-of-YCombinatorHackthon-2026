import { Loader2, Phone, Save, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { agentsApi } from "../api/agents";
import type { PhonePolicy } from "../api/types";
import { getErrorMessage } from "../legacy/shared";

const defaultPolicy: PhonePolicy = {
  requireApprovalOutboundCall: "always",
  requireApprovalSms: "new_recipients",
  allowedCountries: [],
  blockedCallers: [],
  inboundEnabled: true,
  inboundInstructions: "Answer naturally as the agent identity.",
  dailyCallLimit: 20,
  dailySmsLimit: 50,
  quietHours: { start: "22:00", end: "08:00", timezone: "Europe/Paris" },
  storeTranscripts: true
};

export function PhonePanel({ siteName, agentId }: { siteName: string; agentId?: string }) {
  const [policy, setPolicy] = useState<PhonePolicy>(defaultPolicy);
  const [savedPolicy, setSavedPolicy] = useState<PhonePolicy>(defaultPolicy);
  const [policyOpen, setPolicyOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setError("");
    void agentsApi.getPhonePolicy(agentId)
      .then((response) => {
        if (cancelled) return;
        setPolicy(response.policy);
        setSavedPolicy(response.policy);
      })
      .catch((loadError) => {
        if (!cancelled) setError(getErrorMessage(loadError, "Could not load phone policy"));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function savePolicy() {
    if (!agentId) {
      setSavedPolicy(policy);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await agentsApi.updatePhonePolicy(agentId, policy);
      setPolicy(response.policy);
      setSavedPolicy(response.policy);
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Could not save phone policy"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="payments-panel-view">
      <header className="site-detail-page__header">
        <div>
          <h1 id="siteDetailTitle">Phone</h1>
          <p className="payments-screen__subtitle">
            {siteName} can place outbound calls and send SMS through its agent identity phone number.
          </p>
        </div>
        <div className="payments-card">
          <Phone size={18} aria-hidden="true" />
          <div>
            <span className="payments-card__brand">Phone + SMS</span>
            <span className="payments-card__meta">policy controlled</span>
          </div>
        </div>
      </header>

      {error ? <p className="field-error" role="alert">{error}</p> : null}

      <div className="payments-panel">
        <button type="button" className="email-settings__toggle" onClick={() => setPolicyOpen((open) => !open)} aria-expanded={policyOpen}>
          <Settings size={16} aria-hidden="true" />
          <span>Phone policy</span>
        </button>
        {policyOpen ? (
          <PhonePolicyEditor
            policy={policy}
            savedPolicy={savedPolicy}
            isSaving={busy}
            onChange={setPolicy}
            onSave={savePolicy}
          />
        ) : null}
      </div>

      <div className="payments-panel">
        <h2 className="payments-panel__title">Call activity</h2>
        <p className="payments-empty">No calls yet. Ask in Chat to call a person, business, or service.</p>
      </div>
    </div>
  );
}

function PhonePolicyEditor({
  policy,
  savedPolicy,
  isSaving,
  onChange,
  onSave
}: {
  policy: PhonePolicy;
  savedPolicy: PhonePolicy;
  isSaving: boolean;
  onChange: (policy: PhonePolicy) => void;
  onSave: () => Promise<void>;
}) {
  const isDirty = JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  return (
    <div className="agent-email-policy">
      <div className="agent-email-policy__modes" role="radiogroup" aria-label="Call approval mode">
        {approvalOptions.map(([value, label]) => (
          <label key={value} className="agent-email-policy__mode">
            <input
              type="radio"
              name="call-approval-mode"
              value={value}
              checked={policy.requireApprovalOutboundCall === value}
              onChange={() => onChange({ ...policy, requireApprovalOutboundCall: value })}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div className="agent-email-policy__modes" role="radiogroup" aria-label="SMS approval mode">
        {approvalOptions.map(([value, label]) => (
          <label key={value} className="agent-email-policy__mode">
            <input
              type="radio"
              name="sms-approval-mode"
              value={value}
              checked={policy.requireApprovalSms === value}
              onChange={() => onChange({ ...policy, requireApprovalSms: value })}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <label className="site-detail-page__field">
        <span>Allowed countries</span>
        <input
          value={policy.allowedCountries.join(", ")}
          onChange={(event) => onChange({ ...policy, allowedCountries: parseCsv(event.target.value).map((value) => value.toUpperCase()) })}
          placeholder="US, FR, GB"
        />
      </label>

      <div className="agent-email-policy__numbers">
        <label className="site-detail-page__field">
          <span>Daily calls</span>
          <input
            type="number"
            min={0}
            max={10000}
            value={policy.dailyCallLimit}
            onChange={(event) => onChange({ ...policy, dailyCallLimit: Number(event.target.value) })}
          />
        </label>
        <label className="site-detail-page__field">
          <span>Daily SMS</span>
          <input
            type="number"
            min={0}
            max={10000}
            value={policy.dailySmsLimit}
            onChange={(event) => onChange({ ...policy, dailySmsLimit: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="agent-email-policy__numbers">
        <label className="site-detail-page__field">
          <span>Quiet start</span>
          <input
            type="time"
            value={policy.quietHours?.start ?? ""}
            onChange={(event) => onChange({ ...policy, quietHours: { ...(policy.quietHours ?? defaultPolicy.quietHours!), start: event.target.value } })}
          />
        </label>
        <label className="site-detail-page__field">
          <span>Quiet end</span>
          <input
            type="time"
            value={policy.quietHours?.end ?? ""}
            onChange={(event) => onChange({ ...policy, quietHours: { ...(policy.quietHours ?? defaultPolicy.quietHours!), end: event.target.value } })}
          />
        </label>
        <label className="site-detail-page__field">
          <span>Timezone</span>
          <select
            value={policy.quietHours?.timezone ?? "Europe/Paris"}
            onChange={(event) => onChange({ ...policy, quietHours: { ...(policy.quietHours ?? defaultPolicy.quietHours!), timezone: event.target.value } })}
          >
            {["Europe/Paris", "America/Los_Angeles", "America/New_York", "UTC"].map((timezone) => (
              <option key={timezone} value={timezone}>{timezone}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="site-detail-page__field">
        <span>Inbound instructions</span>
        <textarea
          value={policy.inboundInstructions}
          onChange={(event) => onChange({ ...policy, inboundInstructions: event.target.value })}
        />
      </label>

      <label className="agent-email-policy__mode">
        <input
          type="checkbox"
          checked={policy.inboundEnabled}
          onChange={(event) => onChange({ ...policy, inboundEnabled: event.target.checked })}
        />
        <span>Inbound calls enabled</span>
      </label>

      <label className="agent-email-policy__mode">
        <input
          type="checkbox"
          checked={policy.storeTranscripts}
          onChange={(event) => onChange({ ...policy, storeTranscripts: event.target.checked })}
        />
        <span>Store transcripts</span>
      </label>

      <button className="site-detail-page__save" type="button" disabled={!isDirty || isSaving} onClick={() => void onSave()}>
        {isSaving ? <Loader2 size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
        <span>Save policy</span>
      </button>
    </div>
  );
}

const approvalOptions: Array<[PhonePolicy["requireApprovalOutboundCall"], string]> = [
  ["always", "Always"],
  ["new_recipients", "New"],
  ["never", "Never"]
];

function parseCsv(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}
