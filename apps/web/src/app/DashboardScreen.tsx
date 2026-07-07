import React from "react";
import { LogOut, Plus } from "lucide-react";
import type { Site, SiteApiKey, SiteDetailResponse, User } from "../api";
import type { ToastNotificationInput } from "../components/ToastNotifications";
import { Brand, formatSiteRelativeTime, getProjectCardStyle, getSitePreviewImage, type DashboardSection, type SiteDetailTab, type UserSettingsSection } from "../legacy/shared";
import { DashboardChatIcon, DashboardChatScreen, DashboardSitesIcon, getDashboardChatGreetingName } from "../pages/ChatPage";
import { UserSettingsPage, getUserInitials } from "../pages/SettingsPage";
import { SiteDetailOverlay } from "../pages/AgentDetailPage";

export function DashboardScreen({
  error,
  user,
  sites,
  selectedSite,
  activeSection,
  activeSiteDetailTab,
  activeUserSettingsSection,
  selectedApiKeys,
  onCreateSite,
  onLogout,
  onSelectSite,
  onOpenDashboard,
  onOpenDashboardChat,
  onOpenProfileSettings,
  onUserSettingsSectionChange,
  onUserUpdated,
  onSiteDetailTabChange,
  onApiKeyCreated,
  onApiKeyDeleted,
  onSiteDetailLoaded,
  onSiteUpdated,
  onSiteDeleted,
  onNotify,
  onCloseDetail
}: {
  error: string;
  user: User;
  sites: Site[];
  selectedSite: Site | null;
  activeSection: DashboardSection;
  activeSiteDetailTab: SiteDetailTab;
  activeUserSettingsSection: UserSettingsSection;
  selectedApiKeys: SiteApiKey[];
  onCreateSite: () => void;
  onLogout: () => void;
  onSelectSite: (siteId: string) => void;
  onOpenDashboard: () => void;
  onOpenDashboardChat: () => void;
  onOpenProfileSettings: () => void;
  onUserSettingsSectionChange: (section: UserSettingsSection) => void;
  onUserUpdated: (user: User) => void;
  onSiteDetailTabChange: (siteId: string, tab: SiteDetailTab) => void;
  onApiKeyCreated: (apiKey: SiteApiKey) => void;
  onApiKeyDeleted: (apiKeyId: string) => void;
  onSiteDetailLoaded: (detail: SiteDetailResponse) => void;
  onSiteUpdated: (site: Site) => void;
  onSiteDeleted: (siteId: string) => void;
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
            <button className="dashboard-page__rail-button" type="button" onClick={onCreateSite}>
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
        <DashboardChatScreen user={user} sites={sites} />
      ) : activeSection === "settings" ? (
        <UserSettingsPage
          user={user}
          activeSection={activeUserSettingsSection}
          sites={sites}
          onSectionChange={onUserSettingsSectionChange}
          onUserUpdated={onUserUpdated}
          onNotify={onNotify}
          onBack={onOpenDashboard}
          onLogout={onLogout}
        />
      ) : selectedSite ? (
        <SiteDetailOverlay
          site={selectedSite}
          activeTab={activeSiteDetailTab}
          apiKeys={selectedApiKeys}
          onApiKeyCreated={onApiKeyCreated}
          onApiKeyDeleted={onApiKeyDeleted}
          onSiteDetailLoaded={onSiteDetailLoaded}
          onSiteUpdated={onSiteUpdated}
          onSiteDeleted={onSiteDeleted}
          onNotify={onNotify}
          onTabChange={(tab) => onSiteDetailTabChange(selectedSite.id, tab)}
          onClose={onCloseDetail}
        />
      ) : (
        <section className="dashboard-page__workspace dashboard-page__workspace--projects">
          <div className="dashboard-page__projects-view" aria-labelledby="sitesTitle">
            <div className="dashboard-page__projects-shell">
              <header className="dashboard-page__projects-header">
                <h1 id="sitesTitle" className="dashboard-page__projects-title">
                  Agent identities
                </h1>
              </header>

              <div className="dashboard-page__projects-grid-shell">
                {error ? (
                  <ProjectsState message={error} />
                ) : sites.length === 0 ? (
                  <button className="dashboard-page__empty-state" type="button" onClick={onCreateSite}>
                    <Plus size={20} aria-hidden="true" />
                    <span>Create your first agent identity</span>
                    <small>Provision phone, email, card, calendar, and an OpenClaw link.</small>
                  </button>
                ) : (
                  <div className="dashboard-page__projects-grid">
                    <button
                      className="dashboard-page__project-card dashboard-page__project-card--create"
                      type="button"
                      style={getProjectCardStyle(0)}
                      onClick={onCreateSite}
                    >
                      <div className="dashboard-page__project-preview dashboard-page__project-preview--create">
                        <Plus size={24} aria-hidden="true" />
                      </div>
                      <div className="dashboard-page__project-meta">
                        <div className="dashboard-page__project-copy">
                          <h2>New identity</h2>
                          <p>Give an agent real-world tools</p>
                        </div>
                      </div>
                    </button>

                    {sites.map((site, index) => (
                      <button
                        key={site.id}
                        className="dashboard-page__project-card"
                        type="button"
                        style={getProjectCardStyle(index + 1)}
                        onClick={() => onSelectSite(site.id)}
                      >
                        <div className="dashboard-page__project-preview">
                          <img src={getSitePreviewImage(site)} alt="" aria-hidden="true" />
                        </div>
                        <div className="dashboard-page__project-meta">
                          <div className="dashboard-page__project-copy">
                            <h2 title={site.name}>{site.name}</h2>
                            <p>{formatSiteRelativeTime(site.updatedAt)}</p>
                          </div>
                          <span className="dashboard-page__project-pill">OpenClaw linked</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function ProjectsState({ message }: { message: string }) {
  return <div className="dashboard-page__projects-state">{message}</div>;
}
