import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { getApiBaseUrl } from "../api/client";
import type { AgentDetailResponse, AgentListItem, Approval, CreateAgentResponse, IdentityToken } from "../api/types";
import { api, type User } from "../api";
import { ToastNotifications, type ToastNotification, type ToastNotificationInput } from "../components/ToastNotifications";
import { approvalsPath, dashboardChatPath, dashboardPath, getCurrentLocation, getErrorMessage, getSiteDetailPath, getSiteDetailRoute, getUserSettingsPath, getUserSettingsSection, isAppRoute, isApprovalsRoute, isDashboardChatRoute, isNewSiteRoute, isPlansRoute, isProtectedAppRoute, isSigninRoute, isUserSettingsRoute, navigateToPublicHome, newSitePath, signinPath, type DashboardSection } from "../legacy/shared";
import { AuthScreen } from "../pages/AuthPage";
import { AgentCreationWizard } from "../pages/AgentsListPage";
import { LandingPage, PricingPage } from "../pages/PublicPages";
import { DashboardScreen } from "./DashboardScreen";

export function AppShell() {
  const [currentLocation, setCurrentLocation] = useState(getCurrentLocation);
  const [user, setUser] = useState<User | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentDetailResponse | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<Approval[]>([]);
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
    : isApprovalsRoute(currentPath)
      ? "approvals"
    : isDashboardChatRoute(currentPath)
      ? "chat"
      : "sites";
  const focusedApprovalId = useMemo(() => new URLSearchParams(currentSearch).get("focus"), [currentSearch]);

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
    if (!user) return;
    let eventSource: EventSource | null = null;
    let reconnectTimeout: number | null = null;
    let lastEventAt = new Date().toISOString();
    let isStopped = false;

    const connect = () => {
      const apiBaseUrl = getApiBaseUrl();
      const search = new URLSearchParams({ since: lastEventAt });
      eventSource = new EventSource(`${apiBaseUrl}/api/v1/events?${search.toString()}`, { withCredentials: true });
      eventSource.addEventListener("approval.requested", (event) => {
        lastEventAt = new Date().toISOString();
        const approval = JSON.parse((event as MessageEvent).data) as Approval;
        setPendingApprovals((current) => upsertApproval(current, approval).filter((item) => item.status === "pending"));
        showNotification({ title: approval.payloadSummary || "Approval requested" });
      });
      const handleTerminal = (event: Event) => {
        lastEventAt = new Date().toISOString();
        const approval = JSON.parse((event as MessageEvent).data) as Approval;
        setPendingApprovals((current) => current.filter((item) => item.id !== approval.id));
        setApprovalHistory((current) => upsertApproval(current, approval));
      };
      eventSource.addEventListener("approval.decided", handleTerminal);
      eventSource.addEventListener("approval.expired", handleTerminal);
      eventSource.onerror = () => {
        eventSource?.close();
        void refreshPendingApprovals();
        if (!isStopped) {
          reconnectTimeout = window.setTimeout(connect, 2500);
        }
      };
    };

    void refreshPendingApprovals();
    if (typeof EventSource === "undefined") {
      return;
    }
    connect();
    return () => {
      isStopped = true;
      eventSource?.close();
      if (reconnectTimeout !== null) window.clearTimeout(reconnectTimeout);
    };
  }, [user?.id]);

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
      await refreshPendingApprovals();
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
      setPendingApprovals([]);
      setApprovalHistory([]);
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

  async function refreshPendingApprovals() {
    const response = await approvalsApi.list("pending");
    setPendingApprovals(response.approvals);
  }

  async function refreshApprovalHistory() {
    const response = await approvalsApi.list("all");
    setApprovalHistory(response.approvals.filter((approval) => approval.status !== "pending"));
  }

  async function decideApproval(approvalId: string, decision: "approve" | "reject", note?: string) {
    const previousPending = pendingApprovals;
    const selected = pendingApprovals.find((approval) => approval.id === approvalId);
    if (selected) {
      const optimistic: Approval = {
        ...selected,
        status: decision === "approve" ? "approved" : "rejected",
        decisionNote: note?.trim() || null,
        decidedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      setPendingApprovals((current) => current.filter((approval) => approval.id !== approvalId));
      setApprovalHistory((current) => upsertApproval(current, optimistic));
    }
    try {
      const response = decision === "approve"
        ? await approvalsApi.approve(approvalId, note)
        : await approvalsApi.reject(approvalId, note);
      setApprovalHistory((current) => upsertApproval(current, response.approval));
      showNotification({ title: decision === "approve" ? "Approval granted" : "Approval rejected" });
    } catch (error) {
      setPendingApprovals(previousPending);
      showNotification({ kind: "error", title: getErrorMessage(error, "Approval decision failed") });
      throw error;
    }
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
        pendingApprovals={pendingApprovals}
        approvalHistory={approvalHistory}
        focusedApprovalId={focusedApprovalId}
        activeSiteDetailTab={activeSiteDetailTab}
        activeUserSettingsSection={activeUserSettingsSection}
        onCreateAgent={() => pushPath(newSitePath)}
        onLogout={handleLogout}
        onSelectAgent={(agentId) => pushPath(getSiteDetailPath(agentId, "credentials"))}
        onOpenDashboard={() => replacePath(dashboardPath)}
        onOpenApprovals={() => pushPath(approvalsPath)}
        onOpenDashboardChat={() => replacePath(dashboardChatPath)}
        onOpenProfileSettings={() => replacePath(getUserSettingsPath("profile"))}
        onUserSettingsSectionChange={(section) => pushPath(getUserSettingsPath(section))}
        onUserUpdated={setUser}
        onAgentDetailLoaded={applyAgentDetailResponse}
        onAgentUpdated={applyAgentDetailResponse}
        onAgentDeleted={handleAgentDeleted}
        onTokensChanged={handleTokensChanged}
        onNotify={showNotification}
        onApproveApproval={(approvalId, note) => decideApproval(approvalId, "approve", note)}
        onRejectApproval={(approvalId, note) => decideApproval(approvalId, "reject", note)}
        onRefreshApprovalHistory={refreshApprovalHistory}
        onCloseDetail={() => {
          setSelectedAgentDetail(null);
          replacePath(dashboardPath);
        }}
      />
      <ToastNotifications notifications={notifications} />
    </>
  );
}

function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  return [approval, ...approvals.filter((item) => item.id !== approval.id)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
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
