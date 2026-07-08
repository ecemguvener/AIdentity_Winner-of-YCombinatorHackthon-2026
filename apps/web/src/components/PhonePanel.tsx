import { ArrowDownLeft, ArrowUpRight, Copy, Loader2, MessageSquare, Phone, Save, Send, Settings, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentsApi } from "../api/agents";
import { phoneApi } from "../api/phone";
import type {
  Agent,
  AgentPhoneCall,
  AgentPhoneCallsResponse,
  AgentPhoneOverviewResponse,
  AgentProvisioningSummary,
  AgentSmsConversation,
  AgentSmsThreadResponse,
  PhonePolicy
} from "../api/types";
import { getApiBaseUrl } from "../api/client";
import { getErrorMessage } from "../shared";
import type { ToastNotificationInput } from "./ToastNotifications";

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

export function PhonePanel({
  agent,
  provisioning,
  onEnablePhone,
  onNotify
}: {
  agent: Agent;
  provisioning: AgentProvisioningSummary["phone"];
  onEnablePhone: () => Promise<void>;
  onNotify: (notification: ToastNotificationInput) => void;
}) {
  const [overview, setOverview] = useState<AgentPhoneOverviewResponse | null>(null);
  const [callsState, setCallsState] = useState<AgentPhoneCallsResponse>({ calls: [], next_cursor: null });
  const [conversations, setConversations] = useState<AgentSmsConversation[]>([]);
  const [activeCounterparty, setActiveCounterparty] = useState<string | null>(null);
  const [smsThread, setSmsThread] = useState<AgentSmsThreadResponse>({ messages: [], next_cursor: null });
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PhonePolicy>(defaultPolicy);
  const [savedPolicy, setSavedPolicy] = useState<PhonePolicy>(defaultPolicy);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [testCallOpen, setTestCallOpen] = useState(false);
  const [testCallTo, setTestCallTo] = useState("");
  const [smsBody, setSmsBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refreshOverview = useCallback(async () => {
    const response = await phoneApi.getOverview(agent.id);
    setOverview(response);
    setPolicy(response.policy);
    setSavedPolicy(response.policy);
    return response;
  }, [agent.id]);

  const refreshCalls = useCallback(async () => {
    const response = await phoneApi.getCalls(agent.id);
    setCallsState(response);
    return response;
  }, [agent.id]);

  const refreshConversations = useCallback(async () => {
    const response = await phoneApi.getSmsConversations(agent.id);
    setConversations(response.conversations);
    setActiveCounterparty((current) => current ?? response.conversations[0]?.counterparty_e164 ?? null);
    return response;
  }, [agent.id]);

  const refreshThread = useCallback(async (counterparty: string) => {
    const response = await phoneApi.getSmsThread(agent.id, counterparty);
    setSmsThread(response);
    return response;
  }, [agent.id]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    setBusy("load");
    Promise.all([refreshOverview(), refreshCalls(), refreshConversations()])
      .catch((loadError) => {
        if (!cancelled) setError(getErrorMessage(loadError, "Could not load phone data"));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCalls, refreshConversations, refreshOverview]);

  useEffect(() => {
    if (!activeCounterparty) {
      setSmsThread({ messages: [], next_cursor: null });
      return;
    }
    let cancelled = false;
    refreshThread(activeCounterparty).catch((loadError) => {
      if (!cancelled) setError(getErrorMessage(loadError, "Could not load SMS thread"));
    });
    return () => {
      cancelled = true;
    };
  }, [activeCounterparty, refreshThread]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`${getApiBaseUrl()}/api/v1/events`, { withCredentials: true });
    const refreshIfOwnAgent = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { agentId?: string };
        if (payload.agentId && payload.agentId !== agent.id) return;
      } catch {
        // Keep reload fallback for server-side event shape changes.
      }
      void refreshCalls();
      void refreshConversations();
      if (activeCounterparty) void refreshThread(activeCounterparty);
    };
    source.addEventListener("call.started", refreshIfOwnAgent);
    source.addEventListener("call.completed", refreshIfOwnAgent);
    source.addEventListener("sms.received", refreshIfOwnAgent);
    return () => source.close();
  }, [activeCounterparty, agent.id, refreshCalls, refreshConversations, refreshThread]);

  const phoneNumber = overview?.phone.number ?? null;
  const selectedCall = useMemo(() => callsState.calls.find((call) => call.id === selectedCallId) ?? callsState.calls[0] ?? null, [callsState.calls, selectedCallId]);
  const statusLabel = phoneNumber?.status ?? provisioning.state.replace(/_/g, " ");
  const canUsePhone = Boolean(phoneNumber && phoneNumber.status === "active");

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(getErrorMessage(actionError, "Phone action failed"));
    } finally {
      setBusy(null);
    }
  }

  async function savePolicy() {
    await run("policy", async () => {
      const saved = await agentsApi.updatePhonePolicy(agent.id, policy);
      setPolicy(saved.policy);
      setSavedPolicy(saved.policy);
      onNotify({ title: "Phone policy saved" });
    });
  }

  async function copyNumber() {
    if (!phoneNumber) return;
    await navigator.clipboard.writeText(phoneNumber.e164);
    onNotify({ title: "Phone number copied" });
  }

  async function submitTestCall() {
    if (!testCallTo.trim()) return;
    await run("test-call", async () => {
      const result = await phoneApi.placeCall(agent.id, { to: testCallTo.trim(), task: "Owner requested a test call." });
      setTestCallOpen(false);
      setTestCallTo("");
      await refreshCalls();
      onNotify({ title: result.approval_id ? "Call approval requested" : "Call queued" });
    });
  }

  async function submitSms() {
    if (!activeCounterparty || !smsBody.trim()) return;
    const draftBody = smsBody.trim();
    setSmsBody("");
    const optimisticId = `draft-${Date.now()}`;
    setSmsThread((current) => ({
      ...current,
      messages: [...current.messages, {
        id: optimisticId,
        direction: "outbound",
        counterparty_e164: activeCounterparty,
        body: draftBody,
        status: "queued",
        twilio_message_sid: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]
    }));
    try {
      const response = await phoneApi.sendSms(agent.id, { to: activeCounterparty, body: draftBody, idempotencyKey: optimisticId });
      if (response.message) {
        setSmsThread((current) => ({
          ...current,
          messages: current.messages.map((message) => message.id === optimisticId ? response.message! : message)
        }));
      }
      await refreshConversations();
    } catch (sendError) {
      setSmsThread((current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== optimisticId)
      }));
      setSmsBody(draftBody);
      setError(getErrorMessage(sendError, "Could not send SMS"));
    }
  }

  if (!agent.capabilities.phone && provisioning.state !== "pending") {
    return (
      <section className="email-inbox" aria-labelledby="phoneTitle">
        <header className="email-inbox__header">
          <div>
            <h2 id="phoneTitle">Phone</h2>
            <p>Phone and SMS are disabled for this agent identity.</p>
          </div>
          <button type="button" disabled={busy === "enable"} onClick={() => void run("enable", onEnablePhone)}>
            {busy === "enable" ? <Loader2 size={16} aria-hidden="true" /> : <Phone size={16} aria-hidden="true" />}
            <span>Enable phone</span>
          </button>
        </header>
      </section>
    );
  }

  return (
    <section className="email-inbox" aria-labelledby="phoneTitle">
      <header className="email-inbox__header">
        <div>
          <h2 id="phoneTitle">Phone</h2>
          <p>{phoneNumber ? `${countryFlag(phoneNumber.country)} ${formatPhone(phoneNumber.e164)}` : "Phone number provisioning"}</p>
        </div>
        <div className="email-inbox__header-actions">
          <span className={`email-inbox__status email-inbox__status--${phoneNumber?.status === "active" ? "active" : "paused"}`}>{statusLabel}</span>
          {phoneNumber ? (
            <button type="button" className="icon-button" onClick={() => void copyNumber()} aria-label="Copy phone number">
              <Copy size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" disabled={!canUsePhone} onClick={() => setTestCallOpen(true)}>
            <Phone size={16} aria-hidden="true" />
            <span>Test call me</span>
          </button>
        </div>
      </header>

      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {provisioning.state === "pending" || phoneNumber?.status === "provisioning" ? (
        <div className="email-inbox__banner">
          <Loader2 size={16} aria-hidden="true" />
          <span>Provisioning phone number</span>
        </div>
      ) : null}

      {testCallOpen ? (
        <div className="email-compose" role="dialog" aria-label="Test call">
          <div className="email-compose__heading">
            <h3>Test call</h3>
            <button type="button" className="icon-button" onClick={() => setTestCallOpen(false)} aria-label="Close test call">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <input value={testCallTo} onChange={(event) => setTestCallTo(event.target.value)} placeholder="+15551234567" aria-label="Your phone number" />
          <button type="button" disabled={busy === "test-call" || !testCallTo.trim()} onClick={() => void submitTestCall()}>
            {busy === "test-call" ? <Loader2 size={16} aria-hidden="true" /> : <Phone size={16} aria-hidden="true" />}
            <span>Call</span>
          </button>
        </div>
      ) : null}

      <div className="email-inbox__layout">
        <aside className="email-inbox__threads" aria-label="Calls">
          {busy === "load" ? (
            <div className="email-inbox__empty"><Loader2 size={18} aria-hidden="true" /> Loading</div>
          ) : callsState.calls.length ? (
            callsState.calls.map((call) => (
              <CallButton key={call.id} call={call} active={call.id === selectedCall?.id} onSelect={() => setSelectedCallId(call.id)} />
            ))
          ) : (
            <div className="email-inbox__empty"><Phone size={18} aria-hidden="true" /> No calls yet</div>
          )}
        </aside>
        <main className="email-inbox__conversation" aria-label="Call detail">
          {selectedCall ? <CallDetail call={selectedCall} /> : <div className="email-inbox__empty"><Phone size={20} aria-hidden="true" /> Select a call</div>}
        </main>
      </div>

      <div className="email-inbox__layout">
        <aside className="email-inbox__threads" aria-label="SMS conversations">
          {conversations.length ? conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.counterparty_e164}
              className={conversation.counterparty_e164 === activeCounterparty ? "email-thread email-thread--active" : "email-thread"}
              onClick={() => setActiveCounterparty(conversation.counterparty_e164)}
            >
              <span className="email-thread__glyph" aria-hidden="true"><MessageSquare size={14} /></span>
              <span className="email-thread__main">
                <strong>{formatPhone(conversation.counterparty_e164)}</strong>
                <small>{conversation.last_message.body}</small>
              </span>
              <span className="email-thread__meta">{conversation.message_count}</span>
            </button>
          )) : <div className="email-inbox__empty"><MessageSquare size={18} aria-hidden="true" /> No SMS yet</div>}
        </aside>
        <main className="email-inbox__conversation" aria-label="SMS thread">
          <div className="email-inbox__messages">
            {smsThread.messages.map((message) => (
              <article key={message.id} className={`email-message email-message--${message.direction}`}>
                <div className="email-message__meta">
                  <strong>{message.direction === "outbound" ? "Agent" : formatPhone(message.counterparty_e164)}</strong>
                  <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time>
                </div>
                <p>{message.body}</p>
              </article>
            ))}
          </div>
          <div className="email-reply">
            <textarea value={smsBody} onChange={(event) => setSmsBody(event.target.value)} placeholder={activeCounterparty ? `Text ${formatPhone(activeCounterparty)}` : "Select a conversation"} aria-label="SMS message" />
            <button type="button" disabled={!activeCounterparty || !smsBody.trim()} onClick={() => void submitSms()}>
              <Send size={16} aria-hidden="true" />
              <span>Send</span>
            </button>
          </div>
        </main>
      </div>

      <section className="email-settings">
        <button type="button" className="email-settings__toggle" onClick={() => setPolicyOpen((open) => !open)} aria-expanded={policyOpen}>
          <Settings size={16} aria-hidden="true" />
          <span>Phone policy</span>
        </button>
        {policyOpen ? (
          <PhonePolicyEditor policy={policy} savedPolicy={savedPolicy} isSaving={busy === "policy"} onChange={setPolicy} onSave={savePolicy} />
        ) : null}
      </section>
    </section>
  );
}

function CallButton({ call, active, onSelect }: { call: AgentPhoneCall; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={active ? "email-thread email-thread--active" : "email-thread"} onClick={onSelect}>
      <span className="email-thread__glyph" aria-hidden="true">{call.direction === "outbound" ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}</span>
      <span className="email-thread__main">
        <strong>{formatPhone(call.counterparty_e164)}</strong>
        <span>{call.summary ?? call.task ?? call.status}</span>
        <small>{call.duration_secs ? `${Math.round(call.duration_secs / 60)} min` : call.status}</small>
      </span>
      <span className="email-thread__meta"><time dateTime={call.created_at}>{relativeTime(call.created_at)}</time></span>
    </button>
  );
}

function CallDetail({ call }: { call: AgentPhoneCall }) {
  return (
    <>
      <div className="email-inbox__conversation-heading">
        <div>
          <h3>{formatPhone(call.counterparty_e164)}</h3>
          <p>{call.summary ?? call.task ?? call.status}</p>
        </div>
        <span>{call.cost_cents == null ? call.status : `${call.cost_cents} cents`}</span>
      </div>
      {call.summary ? <div className="email-inbox__summary"><strong>{call.summary}</strong></div> : null}
      <div className="email-inbox__messages">
        {call.transcript.length ? call.transcript.map((turn, index) => (
          <article key={`${turn.timeInCallSecs}-${index}`} className={`email-message email-message--${turn.role === "agent" ? "outbound" : "inbound"}`}>
            <div className="email-message__meta">
              <strong>{turn.role}</strong>
              <span>{turn.timeInCallSecs == null ? "" : `${turn.timeInCallSecs}s`}</span>
            </div>
            <p>{turn.message}</p>
          </article>
        )) : <div className="email-inbox__empty">No transcript yet</div>}
      </div>
    </>
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
            <input type="radio" name="call-approval-mode" value={value} checked={policy.requireApprovalOutboundCall === value} onChange={() => onChange({ ...policy, requireApprovalOutboundCall: value })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <div className="agent-email-policy__modes" role="radiogroup" aria-label="SMS approval mode">
        {approvalOptions.map(([value, label]) => (
          <label key={value} className="agent-email-policy__mode">
            <input type="radio" name="sms-approval-mode" value={value} checked={policy.requireApprovalSms === value} onChange={() => onChange({ ...policy, requireApprovalSms: value })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <label className="site-detail-page__field">
        <span>Allowed countries</span>
        <input value={policy.allowedCountries.join(", ")} onChange={(event) => onChange({ ...policy, allowedCountries: parseCsv(event.target.value).map((value) => value.toUpperCase()) })} placeholder="US, FR, GB" />
      </label>
      <div className="agent-email-policy__numbers">
        <label className="site-detail-page__field">
          <span>Daily calls</span>
          <input type="number" min={0} max={10000} value={policy.dailyCallLimit} onChange={(event) => onChange({ ...policy, dailyCallLimit: Number(event.target.value) })} />
        </label>
        <label className="site-detail-page__field">
          <span>Daily SMS</span>
          <input type="number" min={0} max={10000} value={policy.dailySmsLimit} onChange={(event) => onChange({ ...policy, dailySmsLimit: Number(event.target.value) })} />
        </label>
      </div>
      <div className="agent-email-policy__numbers">
        <label className="site-detail-page__field">
          <span>Quiet start</span>
          <input type="time" value={policy.quietHours?.start ?? ""} onChange={(event) => onChange({ ...policy, quietHours: { ...(policy.quietHours ?? defaultPolicy.quietHours!), start: event.target.value } })} />
        </label>
        <label className="site-detail-page__field">
          <span>Quiet end</span>
          <input type="time" value={policy.quietHours?.end ?? ""} onChange={(event) => onChange({ ...policy, quietHours: { ...(policy.quietHours ?? defaultPolicy.quietHours!), end: event.target.value } })} />
        </label>
        <label className="site-detail-page__field">
          <span>Timezone</span>
          <select value={policy.quietHours?.timezone ?? "Europe/Paris"} onChange={(event) => onChange({ ...policy, quietHours: { ...(policy.quietHours ?? defaultPolicy.quietHours!), timezone: event.target.value } })}>
            {["Europe/Paris", "America/Los_Angeles", "America/New_York", "UTC"].map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
          </select>
        </label>
      </div>
      <label className="site-detail-page__field">
        <span>Inbound instructions</span>
        <textarea value={policy.inboundInstructions} onChange={(event) => onChange({ ...policy, inboundInstructions: event.target.value })} />
      </label>
      <label className="agent-email-policy__mode">
        <input type="checkbox" checked={policy.inboundEnabled} onChange={(event) => onChange({ ...policy, inboundEnabled: event.target.checked })} />
        <span>Inbound calls enabled</span>
      </label>
      <label className="agent-email-policy__mode">
        <input type="checkbox" checked={policy.storeTranscripts} onChange={(event) => onChange({ ...policy, storeTranscripts: event.target.checked })} />
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

function countryFlag(country: string): string {
  if (country.length !== 2) return "";
  return String.fromCodePoint(...country.toUpperCase().split("").map((char) => 127397 + char.charCodeAt(0)));
}

function formatPhone(value: string): string {
  return value.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3");
}

function relativeTime(value: string): string {
  const deltaSeconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (deltaSeconds < 60) return "now";
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;
  return `${Math.round(deltaHours / 24)}d`;
}
