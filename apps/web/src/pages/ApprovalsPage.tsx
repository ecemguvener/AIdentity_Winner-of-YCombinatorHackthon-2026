import { Check, Clock, Mail, MessageSquare, Phone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Approval } from "../api/types";
import type { ToastNotificationInput } from "../components/ToastNotifications";

export function ApprovalsPage({
  approvals,
  history,
  focusedApprovalId,
  onApprove,
  onReject,
  onRefreshHistory,
  onNotify
}: {
  approvals: Approval[];
  history: Approval[];
  focusedApprovalId: string | null;
  onApprove: (approvalId: string, note?: string) => Promise<void>;
  onReject: (approvalId: string, note?: string) => Promise<void>;
  onRefreshHistory: () => Promise<void>;
  onNotify: (notification: ToastNotificationInput) => void;
}) {
  const [activeTab, setActiveTab] = useState<"pending" | "history">("pending");
  const visibleApprovals = activeTab === "pending" ? approvals : history;

  useEffect(() => {
    if (focusedApprovalId) {
      setActiveTab("pending");
      window.setTimeout(() => {
        const focusedElement = document.getElementById(`approval-${focusedApprovalId}`);
        if (typeof focusedElement?.scrollIntoView === "function") {
          focusedElement.scrollIntoView({ block: "center" });
        }
      }, 0);
    }
  }, [focusedApprovalId]);

  return (
    <section className="dashboard-page__workspace dashboard-page__workspace--projects" aria-labelledby="approvalsTitle">
      <div className="dashboard-page__projects-view">
        <div className="dashboard-page__projects-shell">
          <header className="dashboard-page__projects-header approvals-page__header">
            <h1 id="approvalsTitle" className="dashboard-page__projects-title">Approvals</h1>
            <div className="site-detail-page__tabs" role="tablist" aria-label="Approvals">
              <button className="site-detail-page__tab" type="button" aria-selected={activeTab === "pending"} onClick={() => setActiveTab("pending")}>
                Pending
              </button>
              <button
                className="site-detail-page__tab"
                type="button"
                aria-selected={activeTab === "history"}
                onClick={() => {
                  setActiveTab("history");
                  void onRefreshHistory();
                }}
              >
                History
              </button>
            </div>
          </header>

          {visibleApprovals.length === 0 ? (
            <div className="dashboard-page__empty-state" role="status">
              <Clock size={20} aria-hidden="true" />
              <span>{activeTab === "pending" ? "Nothing needs you. Agents are operating within policy." : "No approval history yet."}</span>
            </div>
          ) : (
            <div className="dashboard-page__projects-grid">
              {visibleApprovals.map((approval) => (
                <ApprovalCard
                  approval={approval}
                  isFocused={approval.id === focusedApprovalId}
                  key={approval.id}
                  onApprove={onApprove}
                  onReject={onReject}
                  onNotify={onNotify}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ApprovalCard({
  approval,
  isFocused,
  onApprove,
  onReject,
  onNotify
}: {
  approval: Approval;
  isFocused: boolean;
  onApprove: (approvalId: string, note?: string) => Promise<void>;
  onReject: (approvalId: string, note?: string) => Promise<void>;
  onNotify: (notification: ToastNotificationInput) => void;
}) {
  const [note, setNote] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const payloadDetails = useMemo(() => JSON.stringify(approval.payload, null, 2), [approval.payload]);

  async function decide(decision: "approve" | "reject") {
    setIsBusy(true);
    try {
      if (decision === "approve") {
        await onApprove(approval.id, note);
      } else {
        await onReject(approval.id, note);
      }
    } catch (error) {
      onNotify({ kind: "error", title: error instanceof Error ? error.message : "Approval decision failed" });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <article id={`approval-${approval.id}`} className={`dashboard-page__project-card${isFocused ? " dashboard-page__project-card--focused" : ""}`}>
      <div className="dashboard-page__project-meta">
        <div className="dashboard-page__project-copy">
          <h2>{approval.agentName ?? "Agent"}</h2>
          <p>{approval.payloadSummary}</p>
          <small>{kindLabel(approval.kind)} · expires {formatCountdown(approval.expiresAt)}</small>
        </div>
        <span className={`payments-badge payments-badge--${approval.status}`}>{approval.status}</span>
      </div>
      <details className="site-detail-page__section">
        <summary>Payload details</summary>
        <pre>{payloadDetails}</pre>
      </details>
      {approval.status === "pending" ? (
        <div className="site-detail-page__token-form">
          <input value={note} onChange={(event) => setNote(event.target.value)} aria-label="Decision note" placeholder="Optional note" />
          <button type="button" disabled={isBusy} onClick={() => void decide("approve")}>
            <Check size={15} aria-hidden="true" />
            <span>Approve</span>
          </button>
          <button type="button" disabled={isBusy} onClick={() => void decide("reject")}>
            <X size={15} aria-hidden="true" />
            <span>Reject</span>
          </button>
        </div>
      ) : (
        <p className="payments-muted">{approval.decisionNote || approval.decidedAt || "Expired without a decision"}</p>
      )}
    </article>
  );
}

function kindLabel(kind: Approval["kind"]) {
  if (kind === "email.send") return <><Mail size={14} aria-hidden="true" /> Email</>;
  if (kind === "phone.call") return <><Phone size={14} aria-hidden="true" /> Phone call</>;
  return <><MessageSquare size={14} aria-hidden="true" /> SMS</>;
}

function formatCountdown(value: string): string {
  const remainingMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "now";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `${minutes}m`;
}
