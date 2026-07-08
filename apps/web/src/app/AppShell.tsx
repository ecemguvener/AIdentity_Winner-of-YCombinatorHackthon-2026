import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { getApiBaseUrl } from "../api/client";
import type { AgentDetailResponse, AgentListItem, Approval, CreateAgentResponse, IdentityToken } from "../api/types";
import { api, type User } from "../api";
import { ToastNotifications, type ToastNotification, type ToastNotificationInput } from "../components/ToastNotifications";
import { approvalsPath, dashboardChatPath, dashboardPath, getCurrentLocation, getErrorMessage, getSiteDetailPath, getSiteDetailRoute, getUserSettingsPath, getUserSettingsSection, isAppRoute, isApprovalsRoute, isDashboardChatRoute, isDocsSiteRoute, isNewSiteRoute, isPairRoute, isPlansRoute, isProtectedAppRoute, isSigninRoute, isUserSettingsRoute, navigateToPublicHome, newSitePath, signinPath, type DashboardSection } from "../shared";
import { AuthScreen } from "../pages/AuthPage";
import { AgentCreationWizard } from "../pages/AgentsListPage";
import { PairingPage } from "../pages/PairingPage";
import { DocsSitePage, LandingPage, PricingPage } from "../pages/PublicPages";
import { DashboardScreen } from "./DashboardScreen";

interface PlanLimitNotice {
  message: string;
  plan?: string;
  upgradeHint?: string;
}

export function AppShell() {
  const [currentLocation, setCurrentLocation] = useState(getCurrentLocation);
  const [user, setUser] = useState<User | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentDetailResponse | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<Approval[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<Approval[]>([]);
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);
  const [planLimitNotice, setPlanLimitNotice] = useState<PlanLimitNotice | null>(null);
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
    const handlePlanLimit = (event: Event) => {
      const detail = (event as CustomEvent<PlanLimitNotice>).detail ?? {};
      setPlanLimitNotice({
        message: detail.message || "Your plan limit was reached.",
        plan: detail.plan,
        upgradeHint: detail.upgradeHint
      });
    };
    window.addEventListener("barkan:plan-limit", handlePlanLimit);
    return () => window.removeEventListener("barkan:plan-limit", handlePlanLimit);
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
      eventSource.addEventListener("onboarding.updated", (event) => {
        lastEventAt = new Date().toISOString();
        const onboarding = JSON.parse((event as MessageEvent).data) as User["onboarding"];
        setUser((current) => current ? { ...current, onboarding } : current);
      });
      eventSource.onerror = () => {
        eventSource?.close();
        void refreshPendingApprovals().catch(() => undefined);
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
      const loadedAgents = await refreshAgents();
      await refreshPendingApprovals();
      if (shouldStartFirstRun(response.user, loadedAgents, path)) {
        replacePath(newSitePath);
      }
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
    void api.me().then(({ user: nextUser }) => setUser(nextUser)).catch(() => undefined);
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

  const planLimitModal = planLimitNotice ? (
    <div className="user-settings-page__modal-backdrop" role="presentation">
      <section
        className="user-settings-page__password-modal plan-limit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-limit-title"
      >
        <header className="user-settings-page__modal-header">
          <div>
            <h2 id="plan-limit-title">Plan limit reached</h2>
            <p>{planLimitNotice.upgradeHint ?? planLimitNotice.message}</p>
          </div>
          <button
            className="user-settings-page__modal-close"
            type="button"
            onClick={() => setPlanLimitNotice(null)}
            aria-label="Close plan limit dialog"
          >
            ×
          </button>
        </header>
        <footer className="user-settings-page__modal-actions">
          <button className="user-settings-page__modal-secondary" type="button" onClick={() => setPlanLimitNotice(null)}>
            Not now
          </button>
          <button
            className="plan-limit-modal__primary"
            type="button"
            onClick={() => {
              setPlanLimitNotice(null);
              pushPath(getUserSettingsPath("billing"));
            }}
          >
            View billing
          </button>
        </footer>
      </section>
    </div>
  ) : null;

  if (isPlansRoute(currentPath)) return <PricingPage />;
  if (isDocsSiteRoute(currentPath)) return <DocsSitePage path={currentPath} />;
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
          const { user: nextUser } = await api.me();
          setUser(nextUser);
          const loadedAgents = await refreshAgents();
          if (shouldStartFirstRun(nextUser, loadedAgents, currentPath)) {
            replacePath(newSitePath);
          } else if (isSigninRoute(currentPath)) {
            replacePath(dashboardPath);
          }
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
        {planLimitModal}
      </>
    );
  }

  if (isPairRoute(currentPath)) {
    return (
      <>
        <PairingPage
          agents={agents}
          search={currentSearch}
          onClose={() => replacePath(dashboardPath)}
          onNotify={showNotification}
        />
        <ToastNotifications notifications={notifications} />
        {planLimitModal}
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
      {planLimitModal}
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

function shouldStartFirstRun(user: User, agents: AgentListItem[], path: string): boolean {
  return isSigninRoute(path) && agents.length === 0 && !user.onboarding.dismissedAt && !user.onboarding.steps.agent_created;
}
