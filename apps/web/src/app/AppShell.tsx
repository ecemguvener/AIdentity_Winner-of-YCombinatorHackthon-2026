import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import type { AgentDetailResponse, AgentListItem, CreateAgentResponse, IdentityToken } from "../api/types";
import { api, type User } from "../api";
import { ToastNotifications, type ToastNotification, type ToastNotificationInput } from "../components/ToastNotifications";
import { dashboardChatPath, dashboardPath, getCurrentLocation, getErrorMessage, getSiteDetailPath, getSiteDetailRoute, getUserSettingsPath, getUserSettingsSection, isAppRoute, isDashboardChatRoute, isNewSiteRoute, isPlansRoute, isProtectedAppRoute, isSigninRoute, isUserSettingsRoute, navigateToPublicHome, newSitePath, signinPath, type DashboardSection } from "../legacy/shared";
import { AuthScreen } from "../pages/AuthPage";
import { AgentCreationWizard } from "../pages/AgentsListPage";
import { LandingPage, PricingPage } from "../pages/PublicPages";
import { DashboardScreen } from "./DashboardScreen";

export function AppShell() {
  const [currentLocation, setCurrentLocation] = useState(getCurrentLocation);
  const [user, setUser] = useState<User | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentDetailResponse | null>(null);
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);
  const notificationIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentPath, currentSearch] = useMemo(() => {
    const [path, search = ""] = currentLocation.split("?", 2);
    return [path, search ? `?${search}` : ""];
  }, [currentLocation]);
  const agentDetailRoute = useMemo(() => getSiteDetailRoute(currentPath, currentSearch), [currentPath, currentSearch]);
  const selectedAgentId = agentDetailRoute?.siteId ?? null;
  const activeSiteDetailTab = agentDetailRoute?.tab ?? "credentials";
  const activeUserSettingsSection = useMemo(
    () => getUserSettingsSection(currentPath, currentSearch),
    [currentPath, currentSearch]
  );
  const isCreatingAgent = isNewSiteRoute(currentPath);
  const activeDashboardSection: DashboardSection = isUserSettingsRoute(currentPath)
    ? "settings"
    : isDashboardChatRoute(currentPath)
      ? "chat"
      : "sites";

  useEffect(() => {
    const handleNavigation = () => setCurrentLocation(getCurrentLocation());
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  useEffect(() => {
    if (!isAppRoute(currentPath)) return;
    if (user && isProtectedAppRoute(currentPath)) return;
    void bootstrap(currentPath);
  }, [currentPath, user]);

  useEffect(() => {
    if (isSigninRoute(currentPath) && user) {
      replacePath(dashboardPath);
    }
  }, [currentPath, user]);

  useEffect(() => {
    if (selectedAgentId && user && !isCreatingAgent) {
      void loadAgentDetail(selectedAgentId);
    } else {
      setSelectedAgentDetail(null);
    }
  }, [selectedAgentId, user, isCreatingAgent]);

  async function bootstrap(path: string) {
    if (api.hasForcedLogout()) {
      void api.logout().catch(() => undefined);
      setUser(null);
      if (isProtectedAppRoute(path)) replacePath(signinPath);
      setIsLoading(false);
      return;
    }

    try {
      const response = await api.me();
      setUser(response.user);
      await refreshAgents();
    } catch {
      setUser(null);
      if (isProtectedAppRoute(path)) replacePath(signinPath);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshAgents() {
    const response = await agentsApi.list();
    setAgents(response.agents);
    return response.agents;
  }

  async function loadAgentDetail(agentId: string) {
    try {
      const response = await agentsApi.get(agentId);
      applyAgentDetailResponse(response);
      setError("");
    } catch (agentError) {
      setError(getErrorMessage(agentError, "Could not load agent identity"));
    }
  }

  function applyAgentDetailResponse(response: AgentDetailResponse) {
    setSelectedAgentDetail(response);
    setAgents((currentAgents) =>
      currentAgents.map((currentAgent) =>
        currentAgent.id === response.agent.id
          ? { ...response.agent, provisioning: response.provisioning }
          : currentAgent
      )
    );
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Keep sign-out available even if a dev proxy or backend process is stale.
    } finally {
      api.markForcedLogout();
      setUser(null);
      setAgents([]);
      setSelectedAgentDetail(null);
      navigateToPublicHome();
    }
  }

  function pushPath(nextPath: string) {
    if (getCurrentLocation() === nextPath) {
      setCurrentLocation(getCurrentLocation());
      return;
    }
    window.history.pushState({}, "", nextPath);
    setCurrentLocation(getCurrentLocation());
  }

  function replacePath(nextPath: string) {
    if (getCurrentLocation() === nextPath) {
      setCurrentLocation(getCurrentLocation());
      return;
    }
    window.history.replaceState({}, "", nextPath);
    setCurrentLocation(getCurrentLocation());
  }

  function handleAgentCreated(response: CreateAgentResponse) {
    setAgents((currentAgents) => [{ ...response.agent, provisioning: emptyProvisioning(response.agent) }, ...currentAgents]);
  }

  function handleTokensChanged(tokens: IdentityToken[]) {
    setSelectedAgentDetail((currentDetail) => (currentDetail ? { ...currentDetail, tokens } : currentDetail));
  }

  function handleAgentDeleted(agentId: string) {
    setAgents((currentAgents) => currentAgents.filter((agent) => agent.id !== agentId));
    setSelectedAgentDetail(null);
    replacePath(dashboardPath);
  }

  function dismissNotification(notificationId: string) {
    setNotifications((currentNotifications) =>
      currentNotifications.filter((notification) => notification.id !== notificationId)
    );
  }

  function showNotification(notification: ToastNotificationInput) {
    const { durationMs = 3600, kind = "success", ...notificationContent } = notification;
    const id = `toast-${Date.now()}-${notificationIdRef.current++}`;
    setNotifications((currentNotifications) => [
      ...currentNotifications.slice(-2),
      { id, kind, ...notificationContent }
    ]);
    window.setTimeout(() => dismissNotification(id), durationMs);
  }

  if (isPlansRoute(currentPath)) return <PricingPage />;
  if (!isAppRoute(currentPath)) return <LandingPage />;

  if (isLoading) {
    return (
      <main className="barkan-loading" aria-label="Loading Barkan">
        <Loader2 className="barkan-loading__spinner" aria-hidden="true" />
      </main>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        key={currentLocation}
        onAuthed={(nextUser) => setUser(nextUser)}
        onReady={async () => {
          await refreshAgents();
          if (isSigninRoute(currentPath)) replacePath(dashboardPath);
        }}
      />
    );
  }

  if (isCreatingAgent) {
    return (
      <>
        <AgentCreationWizard
          onCancel={() => replacePath(dashboardPath)}
          onCreated={handleAgentCreated}
          onNotify={showNotification}
        />
        <ToastNotifications notifications={notifications} />
      </>
    );
  }

  return (
    <>
      <DashboardScreen
        error={error}
        user={user}
        agents={agents}
        selectedAgentDetail={selectedAgentDetail}
        activeSection={activeDashboardSection}
        activeSiteDetailTab={activeSiteDetailTab}
        activeUserSettingsSection={activeUserSettingsSection}
        onCreateAgent={() => pushPath(newSitePath)}
        onLogout={handleLogout}
        onSelectAgent={(agentId) => pushPath(getSiteDetailPath(agentId, "credentials"))}
        onOpenDashboard={() => replacePath(dashboardPath)}
        onOpenDashboardChat={() => replacePath(dashboardChatPath)}
        onOpenProfileSettings={() => replacePath(getUserSettingsPath("profile"))}
        onUserSettingsSectionChange={(section) => pushPath(getUserSettingsPath(section))}
        onUserUpdated={setUser}
        onAgentDetailLoaded={applyAgentDetailResponse}
        onAgentUpdated={applyAgentDetailResponse}
        onAgentDeleted={handleAgentDeleted}
        onTokensChanged={handleTokensChanged}
        onNotify={showNotification}
        onCloseDetail={() => {
          setSelectedAgentDetail(null);
          replacePath(dashboardPath);
        }}
      />
      <ToastNotifications notifications={notifications} />
    </>
  );
}

function emptyProvisioning(agent: CreateAgentResponse["agent"]): AgentDetailResponse["provisioning"] {
  return {
    email: {
      enabled: agent.capabilities.email,
      state: agent.capabilities.email ? "pending" : "not_provisioned",
      detail: agent.capabilities.email ? "Provisioning email..." : undefined
    },
    phone: {
      enabled: agent.capabilities.phone,
      state: agent.capabilities.phone ? "pending" : "not_provisioned",
      detail: agent.capabilities.phone ? "Provisioning phone..." : undefined
    }
  };
}
