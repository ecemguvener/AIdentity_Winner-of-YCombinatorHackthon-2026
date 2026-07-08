import { Copy, Inbox, Loader2, Mail, Paperclip, RefreshCw, Save, Send, Settings, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentsApi } from "../api/agents";
import type {
  Agent,
  AgentEmailMessage,
  AgentEmailThreadDetailResponse,
  AgentEmailThreadListItem,
  AgentEmailThreadsResponse,
  EmailPolicy
} from "../api/types";
import { getApiBaseUrl } from "../api/client";
import type { ToastNotificationInput } from "./ToastNotifications";
import { getErrorMessage } from "../shared";

export function EmailPanel({ agent, onNotify }: { agent: Agent; onNotify: (notification: ToastNotificationInput) => void }) {
  const [threadsState, setThreadsState] = useState<AgentEmailThreadsResponse | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<AgentEmailThreadDetailResponse | null>(null);
  const [replyText, setReplyText] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeText, setComposeText] = useState("");
  const [policyDraft, setPolicyDraft] = useState<EmailPolicy | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [approvalBanner, setApprovalBanner] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refreshThreads = useCallback(async () => {
    const next = await agentsApi.getEmailThreads(agent.id);
    setThreadsState(next);
    setPolicyDraft((current) => current ?? next.policy);
    setActiveThreadId((current) => current ?? next.threads[0]?.id ?? null);
    return next;
  }, [agent.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void refreshThreads()
      .catch((loadError) => {
        if (!cancelled) setError(getErrorMessage(loadError, "Could not load email inbox"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshThreads]);

  useEffect(() => {
    if (!activeThreadId) {
      setThreadDetail(null);
      return;
    }
    let cancelled = false;
    void agentsApi.getEmailThread(agent.id, activeThreadId)
      .then((detail) => {
        if (!cancelled) setThreadDetail(detail);
      })
      .then(() => refreshThreads())
      .catch((loadError) => {
        if (!cancelled) setError(getErrorMessage(loadError, "Could not load email thread"));
      });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, agent.id, refreshThreads]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`${getApiBaseUrl()}/api/v1/events`, { withCredentials: true });
    const refreshFromEvent = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { agentId?: string; threadId?: string };
        if (payload.agentId && payload.agentId !== agent.id) return;
        void refreshThreads();
        if (payload.threadId && payload.threadId === activeThreadId) {
          void agentsApi.getEmailThread(agent.id, payload.threadId).then(setThreadDetail);
        }
      } catch {
        void refreshThreads();
      }
    };
    source.addEventListener("email.received", refreshFromEvent);
    return () => source.close();
  }, [activeThreadId, agent.id, refreshThreads]);

  const latestInbound = useMemo(() => {
    return [...(threadDetail?.messages ?? [])].reverse().find((message) => message.direction === "inbound" && message.summary);
  }, [threadDetail]);

  const identity = threadsState?.emailIdentity ?? null;
  const policy = policyDraft ?? threadsState?.policy ?? null;
  const activeThread = threadsState?.threads.find((thread) => thread.id === activeThreadId) ?? null;

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(getErrorMessage(actionError, "Email action failed"));
    } finally {
      setBusy(null);
    }
  }

  async function copyAddress() {
    if (!identity) return;
    await navigator.clipboard.writeText(identity.email_address);
    onNotify({ title: "Email address copied" });
  }

  async function resumeEmail() {
    await run("resume", async () => {
      await agentsApi.resumeEmail(agent.id);
      await refreshThreads();
      onNotify({ title: "Email resumed" });
    });
  }

  async function submitReply() {
    if (!activeThreadId || !replyText.trim()) return;
    await run("reply", async () => {
      const result = await agentsApi.replyEmail(agent.id, activeThreadId, { text: replyText.trim() });
      handleSendResult(result);
      setReplyText("");
      setThreadDetail(await agentsApi.getEmailThread(agent.id, activeThreadId));
      await refreshThreads();
    });
  }

  async function submitCompose() {
    if (!composeTo.trim() || !composeSubject.trim() || !composeText.trim()) return;
    await run("compose", async () => {
      const result = await agentsApi.sendEmail(agent.id, {
        to: composeTo.trim(),
        subject: composeSubject.trim(),
        text: composeText.trim()
      });
      handleSendResult(result);
      setComposeOpen(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeText("");
      await refreshThreads();
    });
  }

  function handleSendResult(result: Awaited<ReturnType<typeof agentsApi.sendEmail>>) {
    if (!result.ok && result.status === "approval_required") {
      setApprovalBanner(`Approval required: ${result.approval.payloadSummary}`);
      return;
    }
    setApprovalBanner("");
    onNotify({ title: "Email sent" });
  }

  async function savePolicy() {
    if (!policyDraft) return;
    await run("policy", async () => {
      const response = await agentsApi.updateEmailPolicy(agent.id, policyDraft);
      setThreadsState((current) => current ? { ...current, policy: response.policy } : current);
      setPolicyDraft(response.policy);
      onNotify({ title: "Email policy saved" });
    });
  }

  return (
    <section className="email-inbox" aria-labelledby="emailInboxTitle">
      <header className="email-inbox__header">
        <div>
          <h2 id="emailInboxTitle">Email</h2>
          <p>{identity ? identity.email_address : loading ? "Loading email identity" : "Email is not provisioned"}</p>
        </div>
        <div className="email-inbox__header-actions">
          <span className={`email-inbox__status email-inbox__status--${identity?.status ?? "paused"}`}>{identity?.status ?? "not ready"}</span>
          {identity ? (
            <button type="button" className="icon-button" onClick={() => void copyAddress()} aria-label="Copy email address">
              <Copy size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="icon-button" disabled={busy === "refresh"} onClick={() => void run("refresh", async () => { await refreshThreads(); })}>
            {busy === "refresh" ? <Loader2 size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            <span>Refresh</span>
          </button>
          <button type="button" onClick={() => setComposeOpen(true)}>
            <Mail size={16} aria-hidden="true" />
            <span>Compose</span>
          </button>
        </div>
      </header>

      {identity?.status === "paused" ? (
        <div className="email-inbox__banner">
          <span>Email sending is paused.</span>
          <button type="button" disabled={busy === "resume"} onClick={() => void resumeEmail()}>Resume</button>
        </div>
      ) : null}
      {policy ? (
        <div className="email-inbox__usage" aria-label="Email usage today">
          <span>Today</span>
          <strong>{threadsState?.todaySent ?? 0} / {policy.dailySendLimit}</strong>
        </div>
      ) : null}
      {approvalBanner ? (
        <a className="email-inbox__banner email-inbox__banner--approval" href="/approvals">
          {approvalBanner}
        </a>
      ) : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}

      {composeOpen ? (
        <div className="email-compose" role="dialog" aria-label="New email">
          <div className="email-compose__heading">
            <h3>New email</h3>
            <button type="button" className="icon-button" onClick={() => setComposeOpen(false)} aria-label="Close compose">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <input value={composeTo} onChange={(event) => setComposeTo(event.target.value)} placeholder="recipient@example.com" aria-label="Recipient" />
          <input value={composeSubject} onChange={(event) => setComposeSubject(event.target.value)} placeholder="Subject" aria-label="Subject" />
          <textarea value={composeText} onChange={(event) => setComposeText(event.target.value)} placeholder="Message" aria-label="Message" />
          <button type="button" disabled={busy === "compose"} onClick={() => void submitCompose()}>
            {busy === "compose" ? <Loader2 size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            <span>Send</span>
          </button>
        </div>
      ) : null}

      <div className="email-inbox__layout">
        <aside className="email-inbox__threads" aria-label="Email threads">
          {loading ? (
            <div className="email-inbox__empty"><Loader2 size={18} aria-hidden="true" /> Loading</div>
          ) : threadsState?.threads.length ? (
            threadsState.threads.map((thread) => (
              <ThreadButton key={thread.id} thread={thread} active={thread.id === activeThreadId} onSelect={() => setActiveThreadId(thread.id)} />
            ))
          ) : (
            <div className="email-inbox__empty"><Inbox size={18} aria-hidden="true" /> No email yet</div>
          )}
        </aside>

        <main className="email-inbox__conversation" aria-label="Conversation">
          {threadDetail && activeThread ? (
            <>
              <div className="email-inbox__conversation-heading">
                <div>
                  <h3>{threadDetail.thread.subject}</h3>
                  <p>{threadDetail.thread.counterparty}</p>
                </div>
                <span>{threadDetail.messages.length} messages</span>
              </div>
              {latestInbound ? (
                <div className="email-inbox__summary">
                  <strong>{latestInbound.summary}</strong>
                  {latestInbound.suggested_reply ? (
                    <button type="button" onClick={() => setReplyText(latestInbound.suggested_reply ?? "")}>
                      Use suggested reply
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="email-inbox__messages">
                {threadDetail.messages.map((message) => (
                  <MessageBubble key={message.id} agentId={agent.id} message={message} />
                ))}
              </div>
              <div className="email-reply">
                <textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} placeholder={`Reply to ${activeThread.counterparty}`} aria-label="Reply" />
                <button type="button" disabled={busy === "reply" || !replyText.trim()} onClick={() => void submitReply()}>
                  {busy === "reply" ? <Loader2 size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                  <span>Reply</span>
                </button>
              </div>
            </>
          ) : (
            <div className="email-inbox__empty"><Mail size={20} aria-hidden="true" /> Select a thread</div>
          )}
        </main>
      </div>

      {policy ? (
        <section className="email-settings">
          <button type="button" className="email-settings__toggle" onClick={() => setPolicyOpen((open) => !open)} aria-expanded={policyOpen}>
            <Settings size={16} aria-hidden="true" />
            <span>Email policy</span>
          </button>
          {policyOpen ? (
            <EmailPolicyEditor
              policy={policy}
              savedPolicy={threadsState?.policy ?? null}
              isSaving={busy === "policy"}
              onChange={setPolicyDraft}
              onSave={savePolicy}
            />
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function ThreadButton({ thread, active, onSelect }: { thread: AgentEmailThreadListItem; active: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={active ? "email-thread email-thread--active" : "email-thread"} onClick={onSelect}>
      <span className="email-thread__glyph" aria-hidden="true">{thread.lastDirection === "inbound" ? "In" : "Out"}</span>
      <span className="email-thread__main">
        <strong>{thread.counterparty}</strong>
        <span>{thread.subject}</span>
        <small>{thread.snippet}</small>
      </span>
      <span className="email-thread__meta">
        <time dateTime={thread.lastMessageAt}>{relativeTime(thread.lastMessageAt)}</time>
        {thread.unreadCount ? <b>{thread.unreadCount}</b> : null}
      </span>
    </button>
  );
}

function MessageBubble({ agentId, message }: { agentId: string; message: AgentEmailMessage }) {
  return (
    <article className={`email-message email-message--${message.direction}`}>
      <div className="email-message__meta">
        <strong>{message.direction === "outbound" ? message.to_email : message.from_email}</strong>
        <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time>
      </div>
      <p>{message.body}</p>
      {message.attachments.length ? (
        <div className="email-message__attachments">
          {message.attachments.map((attachment) => attachment.id ? (
            <a
              key={attachment.id}
              href={`${getApiBaseUrl()}/api/v1/agents/${encodeURIComponent(agentId)}/email/threads/${encodeURIComponent(message.thread_id)}/attachments/${encodeURIComponent(attachment.id)}`}
            >
              <Paperclip size={13} aria-hidden="true" />
              <span>{attachment.filename}</span>
            </a>
          ) : (
            <span key={attachment.filename}>
              <Paperclip size={13} aria-hidden="true" />
              {attachment.filename}
            </span>
          ))}
        </div>
      ) : null}
    </article>
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

function relativeTime(value: string): string {
  const deltaSeconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (deltaSeconds < 60) return "now";
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;
  return `${Math.round(deltaHours / 24)}d`;
}
