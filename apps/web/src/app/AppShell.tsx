import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Site, type SiteApiKey, type SiteDetailResponse, type User } from "../api";
import { ToastNotifications, type ToastNotification, type ToastNotificationInput } from "../components/ToastNotifications";
import { AuthScreen } from "../pages/AuthPage";
import { SiteOnboardingScreen } from "../pages/AgentsListPage";
import { LandingPage, PricingPage } from "../pages/PublicPages";
import { DashboardScreen } from "./DashboardScreen";
import { dashboardChatPath, dashboardPath, getCurrentLocation, getErrorMessage, getSiteDetailPath, getSiteDetailRoute, getUserSettingsPath, getUserSettingsSection, isAppRoute, isDashboardChatRoute, isNewSiteRoute, isPlansRoute, isProtectedAppRoute, isSigninRoute, isUserSettingsRoute, navigateToPublicHome, newSitePath, signinPath, type DashboardSection } from "../legacy/shared";

export function AppShell() {
  const [currentLocation, setCurrentLocation] = useState(getCurrentLocation);
  const [user, setUser] = useState<User | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedApiKeys, setSelectedApiKeys] = useState<SiteApiKey[]>([]);
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);
  const notificationIdRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentPath, currentSearch] = useMemo(() => {
    const [path, search = ""] = currentLocation.split("?", 2);
    return [path, search ? `?${search}` : ""];
  }, [currentLocation]);
  const siteDetailRoute = useMemo(() => getSiteDetailRoute(currentPath, currentSearch), [currentPath, currentSearch]);
  const selectedSiteId = siteDetailRoute?.siteId ?? null;
  const activeSiteDetailTab = siteDetailRoute?.tab ?? "credentials";
  const activeUserSettingsSection = useMemo(
    () => getUserSettingsSection(currentPath, currentSearch),
    [currentPath, currentSearch]
  );
  const isCreatingSite = isNewSiteRoute(currentPath);
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
    if (!isAppRoute(currentPath)) {
      return;
    }

    if (user && isProtectedAppRoute(currentPath)) {
      return;
    }

    void bootstrap(currentPath);
  }, [currentPath, user]);

  useEffect(() => {
    if (isSigninRoute(currentPath) && user) {
      replacePath(dashboardPath);
    }
  }, [currentPath, user]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [selectedSiteId, sites]
  );
  useEffect(() => {
    if (selectedSite) {
      void loadSiteDetail(selectedSite.id);
    } else {
      setSelectedApiKeys([]);
    }
  }, [selectedSite?.id]);

  async function bootstrap(path: string) {
    if (api.hasForcedLogout()) {
      void api.logout().catch(() => undefined);
      setUser(null);
      if (isProtectedAppRoute(path)) {
        replacePath(signinPath);
      }
      setIsLoading(false);
      return;
    }

    try {
      const response = await api.me();
      setUser(response.user);
      await refreshSites();
    } catch {
      setUser(null);
      if (isProtectedAppRoute(path)) {
        replacePath(signinPath);
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshSites() {
    const response = await api.listSites();
    setSites(response.sites);
    return response.sites;
  }

  async function loadSiteDetail(siteId: string) {
    try {
      const response = await api.getSite(siteId);
      applySiteDetailResponse(response);
      setError("");
    } catch (siteError) {
      setError(getErrorMessage(siteError, "Could not load site"));
    }
  }

  function applySiteDetailResponse(response: SiteDetailResponse) {
    setSites((currentSites) =>
      currentSites.map((currentSite) => (currentSite.id === response.site.id ? response.site : currentSite))
    );
    setSelectedApiKeys(response.apiKeys);
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Keep sign-out available even if a dev proxy or backend process is stale.
    } finally {
      api.markForcedLogout();
      setUser(null);
      setSites([]);
      setSelectedApiKeys([]);
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

  async function handleSiteCreated(detail: SiteDetailResponse) {
    const refreshedSites = await refreshSites();
    if (!refreshedSites.some((site) => site.id === detail.site.id)) {
      setSites([detail.site, ...refreshedSites]);
    }
    setSelectedApiKeys([]);
    replacePath(dashboardPath);
  }

  function handleSiteUpdated(site: Site) {
    setSites((currentSites) => currentSites.map((currentSite) => (currentSite.id === site.id ? site : currentSite)));
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
      {
        id,
        kind,
        ...notificationContent
      }
    ]);

    window.setTimeout(() => dismissNotification(id), durationMs);
  }

  function handleSiteDeleted(siteId: string) {
    setSites((currentSites) => currentSites.filter((site) => site.id !== siteId));
    setSelectedApiKeys([]);
    replacePath(dashboardPath);
  }

  if (isPlansRoute(currentPath)) {
    return <PricingPage />;
  }

  if (!isAppRoute(currentPath)) {
    return <LandingPage />;
  }

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
          await refreshSites();
          if (isSigninRoute(currentPath)) {
            replacePath(dashboardPath);
          }
        }}
      />
    );
  }

  if (isCreatingSite) {
    return (
      <>
        <SiteOnboardingScreen
          onCancel={() => replacePath(dashboardPath)}
          onCreated={handleSiteCreated}
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
        sites={sites}
        selectedSite={selectedSite}
        activeSection={activeDashboardSection}
        activeSiteDetailTab={activeSiteDetailTab}
        activeUserSettingsSection={activeUserSettingsSection}
        selectedApiKeys={selectedApiKeys}
        onCreateSite={() => pushPath(newSitePath)}
        onLogout={handleLogout}
        onSelectSite={(siteId) => pushPath(getSiteDetailPath(siteId, "credentials"))}
        onOpenDashboard={() => replacePath(dashboardPath)}
        onOpenDashboardChat={() => replacePath(dashboardChatPath)}
        onOpenProfileSettings={() => replacePath(getUserSettingsPath("profile"))}
        onUserSettingsSectionChange={(section) => pushPath(getUserSettingsPath(section))}
        onUserUpdated={setUser}
        onSiteDetailTabChange={(siteId, tab) => pushPath(getSiteDetailPath(siteId, tab))}
        onApiKeyCreated={(apiKey) => setSelectedApiKeys((currentApiKeys) => [apiKey, ...currentApiKeys])}
        onApiKeyDeleted={(apiKeyId) =>
          setSelectedApiKeys((currentApiKeys) => currentApiKeys.filter((apiKey) => apiKey.id !== apiKeyId))
        }
        onSiteDetailLoaded={applySiteDetailResponse}
        onSiteUpdated={handleSiteUpdated}
        onSiteDeleted={handleSiteDeleted}
        onNotify={showNotification}
        onCloseDetail={() => {
          setSelectedApiKeys([]);
          replacePath(dashboardPath);
        }}
      />
      <ToastNotifications notifications={notifications} />
    </>
  );
}
