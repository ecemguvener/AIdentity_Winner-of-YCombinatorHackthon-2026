import { Bell, LogOut, Mail, Phone, Plus } from "lucide-react";
import type { AgentDetailResponse, AgentListItem, Approval, IdentityToken } from "../api/types";
import type { User } from "../api";
import type { ToastNotificationInput } from "../components/ToastNotifications";
import { Brand, formatSiteRelativeTime, getProjectCardStyle, type DashboardSection, type SiteDetailTab, type UserSettingsSection } from "../legacy/shared";
import { DashboardChatIcon, DashboardChatScreen, DashboardSitesIcon, getDashboardChatGreetingName } from "../pages/ChatPage";
import { AgentDetailPage } from "../pages/AgentDetailPage";
import { ApprovalsPage } from "../pages/ApprovalsPage";
import { UserSettingsPage, getUserInitials } from "../pages/SettingsPage";

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
              <Bell size={18} aria-hidden="true" />
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
    publicSiteKey: agent.slug,
    previewImage: "site-preview-dashboard",
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt
  };
}
