import { Check, Clock, Copy, LogOut, Mail, Phone, Plus, ShieldAlert, Terminal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { billingApi, type BillingPlanName } from "../api/billing";
import { agentsApi } from "../api/agents";
import type { AgentDetailResponse, AgentListItem, Approval, IdentityToken } from "../api/types";
import { api, type User, type OnboardingStep } from "../api";
import type { ToastNotificationInput } from "../components/ToastNotifications";
import { Brand, formatSiteRelativeTime, getProjectCardStyle, type DashboardSection, type SiteDetailTab, type UserSettingsSection } from "../shared";
import { DashboardChatIcon, DashboardChatScreen, DashboardSitesIcon, getDashboardChatGreetingName } from "../pages/ChatPage";
import { AgentDetailPage } from "../pages/AgentDetailPage";
import { ApprovalsPage } from "../pages/ApprovalsPage";
import { NotificationTabIcon, UserSettingsPage, getUserInitials } from "../pages/SettingsPage";

export function DashboardScreen({
  error,
  user,
  agents,
  selectedAgentDetail,
  activeSection,
  pendingApprovals,
  approvalHistory,
  focusedApprovalId,
  activeSiteDetailTab,
  activeUserSettingsSection,
  onCreateAgent,
  onLogout,
  onSelectAgent,
  onOpenDashboard,
  onOpenApprovals,
  onOpenDashboardChat,
  onOpenProfileSettings,
  onUserSettingsSectionChange,
  onUserUpdated,
  onAgentDetailLoaded,
  onAgentUpdated,
  onAgentDeleted,
  onTokensChanged,
  onApproveApproval,
  onRejectApproval,
  onRefreshApprovalHistory,
  onNotify,
  onCloseDetail
}: {
  error: string;
  user: User;
  agents: AgentListItem[];
  selectedAgentDetail: AgentDetailResponse | null;
  activeSection: DashboardSection;
  pendingApprovals: Approval[];
  approvalHistory: Approval[];
  focusedApprovalId: string | null;
  activeSiteDetailTab: SiteDetailTab;
  activeUserSettingsSection: UserSettingsSection;
  onCreateAgent: () => void;
  onLogout: () => void;
  onSelectAgent: (agentId: string) => void;
  onOpenDashboard: () => void;
  onOpenApprovals: () => void;
  onOpenDashboardChat: () => void;
  onOpenProfileSettings: () => void;
  onUserSettingsSectionChange: (section: UserSettingsSection) => void;
  onUserUpdated: (user: User) => void;
  onAgentDetailLoaded: (detail: AgentDetailResponse) => void;
  onAgentUpdated: (detail: AgentDetailResponse) => void;
  onAgentDeleted: (agentId: string) => void;
  onTokensChanged: (tokens: IdentityToken[]) => void;
  onApproveApproval: (approvalId: string, note?: string) => Promise<void>;
  onRejectApproval: (approvalId: string, note?: string) => Promise<void>;
  onRefreshApprovalHistory: () => Promise<void>;
  onNotify: (notification: ToastNotificationInput) => void;
  onCloseDetail: () => void;
}) {
  const [billingBadge, setBillingBadge] = useState<{ plan: BillingPlanName; warning: boolean } | null>(null);
  const [sandboxBanner, setSandboxBanner] = useState(false);

  useEffect(() => {
    let isCancelled = false;
    void Promise.all([billingApi.getAccount(), billingApi.getUsage()])
      .then(([account, usage]) => {
        if (isCancelled) return;
        const warning = Object.values(usage.perMeter).some((meter) =>
          meter.included > 0 ? meter.used / meter.included >= 0.8 : meter.used > 0
        );
        setBillingBadge({ plan: account.plan, warning });
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [user.id]);

  useEffect(() => {
    const storageKey = `barkan:sandbox-dismissed:${user.id}`;
    let isCancelled = false;
    void billingApi.getOpsStatus()
      .then((status) => {
        if (isCancelled) return;
        const contactProvidersMock = status.providerModes.email === "mock" || status.providerModes.phone === "mock";
        setSandboxBanner(contactProvidersMock && window.localStorage.getItem(storageKey) !== "true");
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [user.id]);

  return (
    <main className="dashboard-page">
      <aside className="dashboard-page__rail">
        <div className="dashboard-page__rail-top">
          <Brand className="dashboard-page__brand" />
          <nav className="dashboard-page__rail-nav" aria-label="Dashboard">
            <button
              className={`dashboard-page__rail-button${activeSection === "sites" ? " dashboard-page__rail-button--active" : ""}`}
              type="button"
              onClick={onOpenDashboard}
            >
              <DashboardSitesIcon />
              <span>Identities</span>
            </button>
            <button
              className={`dashboard-page__rail-button${activeSection === "chat" ? " dashboard-page__rail-button--active" : ""}`}
              type="button"
              onClick={onOpenDashboardChat}
            >
              <DashboardChatIcon />
              <span>Chat</span>
            </button>
            <button
              className={`dashboard-page__rail-button${activeSection === "approvals" ? " dashboard-page__rail-button--active" : ""}`}
              type="button"
              onClick={onOpenApprovals}
            >
              <NotificationTabIcon className="dashboard-page__rail-icon" />
              <span>Approvals</span>
              {pendingApprovals.length > 0 ? <strong>{pendingApprovals.length}</strong> : null}
            </button>
            <button className="dashboard-page__rail-button" type="button" onClick={onCreateAgent}>
              <Plus size={18} aria-hidden="true" />
              <span>New identity</span>
            </button>
          </nav>
        </div>

        <div className="dashboard-page__rail-footer">
          {billingBadge ? (
            <div className="dashboard-page__plan-badge" title={billingBadge.warning ? "Usage above 80%" : "Current plan"}>
              <span>{billingBadge.plan}</span>
              {billingBadge.warning ? <i aria-label="Usage above 80%" /> : null}
            </div>
          ) : null}
          <button
            className={`dashboard-page__identity${activeSection === "settings" ? " dashboard-page__identity--active" : ""}`}
            type="button"
            title={user.email}
            onClick={onOpenProfileSettings}
          >
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span>{getUserInitials(user.displayName ?? getDashboardChatGreetingName(user.email), user.email)}</span>
            )}
          </button>
          <button className="dashboard-page__logout" type="button" onClick={onLogout}>
            <LogOut size={18} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {sandboxBanner ? (
        <div className="sandbox-banner" role="status">
          <ShieldAlert size={17} aria-hidden="true" />
          <span>Live providers are not connected yet.</span>
          <a href="/docs-site/operators/email">Connect providers</a>
          <button type="button" aria-label="Dismiss sandbox banner" onClick={() => {
            window.localStorage.setItem(`barkan:sandbox-dismissed:${user.id}`, "true");
            setSandboxBanner(false);
          }}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {activeSection === "chat" ? (
        <DashboardChatScreen user={user} sites={agents.map(agentToChatSite)} />
      ) : activeSection === "approvals" ? (
        <ApprovalsPage
          approvals={pendingApprovals}
          history={approvalHistory}
          focusedApprovalId={focusedApprovalId}
          onApprove={onApproveApproval}
          onReject={onRejectApproval}
          onRefreshHistory={onRefreshApprovalHistory}
          onNotify={onNotify}
        />
      ) : activeSection === "settings" ? (
        <UserSettingsPage
          user={user}
          activeSection={activeUserSettingsSection}
          sites={agents.map(agentToChatSite)}
          onSectionChange={onUserSettingsSectionChange}
          onUserUpdated={onUserUpdated}
          onNotify={onNotify}
          onBack={onOpenDashboard}
          onLogout={onLogout}
        />
      ) : selectedAgentDetail ? (
        <AgentDetailPage
          detail={selectedAgentDetail}
          activeTab={activeSiteDetailTab}
          onAgentDetailLoaded={onAgentDetailLoaded}
          onAgentUpdated={onAgentUpdated}
          onAgentDeleted={onAgentDeleted}
          onTokensChanged={onTokensChanged}
          onNotify={onNotify}
          onClose={onCloseDetail}
        />
      ) : (
        <AgentsList
          agents={agents}
          error={error}
          onCreateAgent={onCreateAgent}
          onSelectAgent={onSelectAgent}
        />
      )}
    </main>
  );
}

function AgentsList({
  agents,
  error,
  onCreateAgent,
  onSelectAgent
}: {
  agents: AgentListItem[];
  error: string;
  onCreateAgent: () => void;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <section className="dashboard-page__workspace dashboard-page__workspace--projects">
      <div className="dashboard-page__projects-view" aria-labelledby="agentsTitle">
        <div className="dashboard-page__projects-shell">
          <header className="dashboard-page__projects-header">
            <h1 id="agentsTitle" className="dashboard-page__projects-title">
              Agent identities
            </h1>
          </header>

          <div className="dashboard-page__projects-grid-shell">
            {error ? (
              <div className="dashboard-page__projects-state">{error}</div>
            ) : agents.length === 0 ? (
              <button className="dashboard-page__empty-state" type="button" onClick={onCreateAgent}>
                <Plus size={20} aria-hidden="true" />
                <span>Give your agent a real phone number and email address</span>
                <small>Create an agent identity, then connect it to OpenClaw, Hermes, or your API runtime.</small>
              </button>
            ) : (
              <div className="dashboard-page__projects-grid">
                <button
                  className="dashboard-page__project-card dashboard-page__project-card--create"
                  type="button"
                  style={getProjectCardStyle(0)}
                  onClick={onCreateAgent}
                >
                  <div className="dashboard-page__project-preview dashboard-page__project-preview--create">
                    <Plus size={24} aria-hidden="true" />
                  </div>
                  <div className="dashboard-page__project-meta">
                    <div className="dashboard-page__project-copy">
                      <h2>New identity</h2>
                      <p>Provision real-world tools</p>
                    </div>
                  </div>
                </button>

                {agents.map((agent, index) => (
                  <button
                    key={agent.id}
                    className="dashboard-page__project-card"
                    type="button"
                    style={getProjectCardStyle(index + 1)}
                    onClick={() => onSelectAgent(agent.id)}
                  >
                    <div className="dashboard-page__project-preview dashboard-page__project-preview--create">
                      <span className={`dashboard-page__project-pill dashboard-page__project-pill--${agent.status}`}>{agent.status}</span>
                    </div>
                    <div className="dashboard-page__project-meta">
                      <div className="dashboard-page__project-copy">
                        <h2 title={agent.name}>{agent.name}</h2>
                        <p>{formatSiteRelativeTime(agent.updatedAt)}</p>
                        <small>{contactSummary(agent)}</small>
                      </div>
                      <span className="dashboard-page__project-pill">
                        {agent.capabilities.email ? <Mail size={14} aria-hidden="true" /> : null}
                        {agent.capabilities.phone ? <Phone size={14} aria-hidden="true" /> : null}
                        {provisioningLabel(agent)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ActivationChecklist({
  agents,
  pendingApprovals,
  user,
  onCreateAgent,
  onOpenApprovals,
  onSelectAgent,
  onUserUpdated,
  onNotify
}: {
  agents: AgentListItem[];
  pendingApprovals: Approval[];
  user: User;
  onCreateAgent: () => void;
  onOpenApprovals: () => void;
  onSelectAgent: (agentId: string) => void;
  onUserUpdated: (user: User) => void;
  onNotify: (notification: ToastNotificationInput) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (user.onboarding.dismissedAt || user.onboarding.completedAt) return null;
  const firstAgent = agents[0];
  const stepDone = (step: OnboardingStep) => Boolean(user.onboarding.steps[step]);
  const pendingEmailApproval = pendingApprovals.find((approval) => approval.kind === "email.send");

  async function dismiss() {
    const response = await api.updateOnboarding(true);
    onUserUpdated({ ...user, onboarding: response.onboarding });
  }

  async function sendTestEmail() {
    if (!firstAgent) return;
    setBusy(true);
    try {
      const result = await agentsApi.sendEmail(firstAgent.id, {
        to: user.email,
        subject: "Barkan first action",
        text: `Hi ${user.displayName ?? user.email}, this is your agent identity sending its first governed email.`
      });
      onNotify({ title: result.ok ? "Test email sent" : "Approval requested" });
    } catch (error) {
      onNotify({ kind: "error", title: error instanceof Error ? error.message : "Could not send test email" });
    } finally {
      setBusy(false);
    }
  }

  const rows = [
    { step: "agent_created" as const, title: "Create your agent", action: onCreateAgent, actionLabel: "Create" },
    { step: "runtime_connected" as const, title: "Connect a runtime", action: () => firstAgent && onSelectAgent(firstAgent.id), actionLabel: "Copy snippet" },
    { step: "first_email_sent" as const, title: "Send your first email", action: sendTestEmail, actionLabel: busy ? "Sending" : "Send test email" },
    { step: "approval_decided" as const, title: "Approve it", action: onOpenApprovals, actionLabel: pendingEmailApproval ? "Review approval" : "Open approvals" }
  ];

  return (
    <section className="activation-card" aria-label="Activation checklist">
      <div className="activation-card__header">
        <div>
          <h2>Get to first action</h2>
          <p>Connect a runtime, send one governed email, approve it, then you are live.</p>
        </div>
        <button type="button" aria-label="Dismiss checklist" onClick={() => void dismiss()}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="activation-card__rows">
        {rows.map((row) => (
          <button className="activation-card__row" type="button" key={row.step} disabled={busy && row.step === "first_email_sent"} onClick={() => void row.action()}>
            {stepDone(row.step) ? <Check size={17} aria-hidden="true" /> : <Clock size={17} aria-hidden="true" />}
            <span>{row.title}</span>
            <small>{stepDone(row.step) ? "Done" : row.actionLabel}</small>
          </button>
        ))}
        <button className="activation-card__row" type="button" onClick={() => firstAgent && onSelectAgent(firstAgent.id)}>
          <Phone size={17} aria-hidden="true" />
          <span>Add phone</span>
          <small>Paid plans</small>
        </button>
      </div>
      <div className="activation-card__snippets">
        <Snippet label="MCP pair" value="npx @barkan/mcp --pair" />
        <Snippet label="SDK" value="npm install @barkan/sdk" />
      </div>
    </section>
  );
}

function Snippet({ label, value }: { label: string; value: string }) {
  return (
    <button className="activation-card__snippet" type="button" onClick={() => void navigator.clipboard.writeText(value)}>
      <Terminal size={15} aria-hidden="true" />
      <span>{label}</span>
      <code>{value}</code>
      <Copy size={14} aria-hidden="true" />
    </button>
  );
}

function contactSummary(agent: AgentListItem): string {
  const contacts = [agent.emailAddress, agent.phoneE164].filter(Boolean);
  return contacts.length > 0 ? contacts.join(" · ") : "No contact points provisioned yet";
}

function provisioningLabel(agent: AgentListItem): string {
  if (agent.provisioning.email.state === "pending" || agent.provisioning.phone.state === "pending") {
    return "Provisioning";
  }
  return agent.runtime ?? "OpenClaw";
}

function agentToChatSite(agent: AgentListItem) {
  return {
    id: agent.id,
    name: agent.name,
    domain: agent.runtime ?? "openclaw",
    previewImage: "site-preview-dashboard",
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}
