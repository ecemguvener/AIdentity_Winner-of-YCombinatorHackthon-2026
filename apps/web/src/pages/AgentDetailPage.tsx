import React, { useEffect, useState, type CSSProperties } from "react";
import { Check, Copy, KeyRound, Loader2, Mail, Phone, Server } from "lucide-react";
import { api, type Site, type SiteApiKey, type SiteDetailResponse } from "../api";
import { EmailPanel } from "../components/EmailPanel";
import { PaymentsPanel } from "../components/PaymentsPanel";
import { PhonePanel } from "../components/PhonePanel";
import {
  Brand,
  agentIdentityCapabilities,
  buildIdentityReceipt,
  formatSiteRelativeTime,
  getErrorMessage,
  onboardingSetupSteps,
  sleep,
  type SetupProgressStep,
  type SetupStepProgress,
  type SiteDetailTab,
  type ToastNotificationInput
} from "../legacy/shared";
import { BackChevronIcon, DeleteMinusCircleIcon, SiteSettingsCategoryIcon } from "./SettingsPage";

export function SiteDetailOverlay({
  site,
  activeTab,
  apiKeys,
  onApiKeyCreated,
  onApiKeyDeleted,
  onSiteDetailLoaded,
  onSiteUpdated,
  onSiteDeleted,
  onNotify,
  onTabChange,
  onClose
}: {
  site: Site;
  activeTab: SiteDetailTab;
  apiKeys: SiteApiKey[];
  onApiKeyCreated: (apiKey: SiteApiKey) => void;
  onApiKeyDeleted: (apiKeyId: string) => void;
  onSiteDetailLoaded: (detail: SiteDetailResponse) => void;
  onSiteUpdated: (site: Site) => void;
  onSiteDeleted: (siteId: string) => void;
  onNotify: (notification: ToastNotificationInput) => void;
  onTabChange: (tab: SiteDetailTab) => void;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState(site.name);
  const [draftDomain, setDraftDomain] = useState(site.domain);
  const [draftDescription, setDraftDescription] = useState("");
  const [isSavingSite, setIsSavingSite] = useState(false);
  const [siteSaveError, setSiteSaveError] = useState("");
  const [createdApiKeySecret, setCreatedApiKeySecret] = useState<{
    apiKeyId: string;
    secret: string;
  } | null>(null);
  const [apiKeyError, setApiKeyError] = useState("");
  const [isCreatingApiKey, setIsCreatingApiKey] = useState(false);
  const [deletingApiKeyId, setDeletingApiKeyId] = useState<string | null>(null);
  const [copiedApiKeyId, setCopiedApiKeyId] = useState<string | null>(null);
  const [isDeletingSite, setIsDeletingSite] = useState(false);
  const [siteDeleteError, setSiteDeleteError] = useState("");
  useEffect(() => {
    setDraftName(site.name);
    setDraftDomain(site.domain);
    setSiteSaveError("");
  }, [site.id, site.name, site.domain]);

  useEffect(() => {
    setDraftDescription("");
  }, [site.id]);

  async function copySnippet() {
    await navigator.clipboard.writeText(buildIdentityReceipt(site));
    onNotify({
      title: "Identity receipt copied"
    });
  }

  async function saveSiteSettings() {
    const nextName = draftName.trim();
    const nextDomain = draftDomain.trim();

    if (!nextName || !nextDomain) {
      setSiteSaveError("Identity name and OpenClaw endpoint are required.");
      return;
    }

    const updates: { name?: string; domain?: string } = {};
    if (nextName !== site.name) {
      updates.name = nextName;
    }
    if (nextDomain !== site.domain) {
      updates.domain = nextDomain;
    }

    if (Object.keys(updates).length === 0) {
      setSiteSaveError("");
      return;
    }

    setIsSavingSite(true);
    setSiteSaveError("");

    try {
      const [response] = await Promise.all([
        api.updateSite(site.id, updates),
        sleep(500)
      ]);
      onSiteUpdated(response.site);
      onNotify({
        title: "Identity settings saved"
      });
    } catch (saveError) {
      setSiteSaveError(getErrorMessage(saveError, "Could not save identity settings"));
    } finally {
      setIsSavingSite(false);
    }
  }

  async function createApiKey() {
    setApiKeyError("");
    setIsCreatingApiKey(true);

    try {
      const response = await api.createSiteApiKey(site.id);
      setCreatedApiKeySecret({
        apiKeyId: response.apiKey.id,
        secret: response.secret
      });
      onApiKeyCreated(response.apiKey);
      onNotify({
        title: "Link token created"
      });
    } catch (createError) {
      setApiKeyError(getErrorMessage(createError, "Could not create link token"));
    } finally {
      setIsCreatingApiKey(false);
    }
  }

  async function copyApiKey(apiKeyId: string, secret: string) {
    await navigator.clipboard.writeText(secret);
    setCopiedApiKeyId(apiKeyId);
    onNotify({
      title: "Link token copied"
    });
    window.setTimeout(() => setCopiedApiKeyId(null), 1400);
  }

  async function deleteApiKey(apiKeyId: string) {
    setApiKeyError("");
    setDeletingApiKeyId(apiKeyId);

    try {
      await api.deleteSiteApiKey(site.id, apiKeyId);
      if (createdApiKeySecret?.apiKeyId === apiKeyId) {
        setCreatedApiKeySecret(null);
      }
      onApiKeyDeleted(apiKeyId);
      onNotify({
        title: "Link token deleted"
      });
    } catch (deleteError) {
      setApiKeyError(getErrorMessage(deleteError, "Could not delete link token"));
    } finally {
      setDeletingApiKeyId(null);
    }
  }

  async function deleteSite() {
    const shouldDelete = window.confirm(`Delete ${site.name}? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setSiteDeleteError("");
    setIsDeletingSite(true);

    try {
      await api.deleteSite(site.id);
      onSiteDeleted(site.id);
      onNotify({
        title: "Agent identity deleted"
      });
    } catch (deleteError) {
      setSiteDeleteError(getErrorMessage(deleteError, "Could not delete agent identity"));
      setIsDeletingSite(false);
    }
  }

  const normalizedDraftName = draftName.trim();
  const normalizedDraftDomain = draftDomain.trim();
  const hasSiteDraftChanges = normalizedDraftName !== site.name || normalizedDraftDomain !== site.domain;
  const isSaveDisabled = isSavingSite || !normalizedDraftName || !normalizedDraftDomain || !hasSiteDraftChanges;
  const previewDescription = draftDescription.trim() || "This OpenClaw agent can call, email, pay, schedule, and receive real-world events.";

  return (
    <section className="site-detail-page dashboard-page__workspace" aria-labelledby="siteDetailTitle">
      <div className="site-detail-page__shell">
        <aside className="site-detail-page__sidebar" aria-label="Agent identity sections">
          <button className="site-detail-page__back" type="button" onClick={onClose} aria-label="Back to identities">
            <BackChevronIcon />
          </button>

          <nav className="site-detail-page__tabs" role="tablist" aria-label="Agent identity details">
            <button
              className="site-detail-page__tab"
              id="site-detail-credentials-tab"
              type="button"
              role="tab"
              aria-label="Credentials"
              aria-selected={activeTab === "credentials"}
              aria-controls="site-detail-credentials-panel"
              onClick={() => onTabChange("credentials")}
            >
              <SiteSettingsCategoryIcon icon="general" />
              <span>General</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-openclaw-tab"
              type="button"
              role="tab"
              aria-label="OpenClaw"
              aria-selected={activeTab === "openclaw"}
              aria-controls="site-detail-openclaw-panel"
              onClick={() => onTabChange("openclaw")}
            >
              <SiteSettingsCategoryIcon icon="openclaw" />
              <span>OpenClaw</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-phone-tab"
              type="button"
              role="tab"
              aria-label="Phone"
              aria-selected={activeTab === "phone"}
              aria-controls="site-detail-phone-panel"
              onClick={() => onTabChange("phone")}
            >
              <SiteSettingsCategoryIcon icon="phone" />
              <span>Phone</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-payments-tab"
              type="button"
              role="tab"
              aria-label="Payments"
              aria-selected={activeTab === "payments"}
              aria-controls="site-detail-payments-panel"
              onClick={() => onTabChange("payments")}
            >
              <SiteSettingsCategoryIcon icon="act-on-behalf" />
              <span>Payments</span>
            </button>
            <button
              className="site-detail-page__tab"
              id="site-detail-email-tab"
              type="button"
              role="tab"
              aria-label="Email"
              aria-selected={activeTab === "email"}
              aria-controls="site-detail-email-panel"
              onClick={() => onTabChange("email")}
            >
              <SiteSettingsCategoryIcon icon="email" />
              <span>Email</span>
            </button>
          </nav>
        </aside>

        <div
          className="site-detail-page__content"
          key={activeTab}
          id={`site-detail-${activeTab}-panel`}
          role="tabpanel"
          aria-labelledby={`site-detail-${activeTab}-tab`}
        >
          {activeTab === "payments" ? (
            <PaymentsPanel siteId={site.id} siteName={site.name} />
          ) : activeTab === "email" ? (
            <EmailPanel siteId={site.id} siteName={site.name} />
          ) : activeTab === "phone" ? (
            <PhonePanel siteName={site.name} />
          ) : activeTab === "credentials" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="siteDetailTitle">Identity</h1>
                </div>
                <button
                  className={`site-detail-page__save${isSavingSite ? " site-detail-page__save--saving" : ""}`}
                  type="button"
                  onClick={() => void saveSiteSettings()}
                  disabled={isSaveDisabled}
                  aria-label={isSavingSite ? "Saving identity settings" : "Save identity settings"}
                >
                  {isSavingSite ? <Loader2 size={15} strokeWidth={3.2} aria-hidden="true" /> : <span>Save</span>}
                </button>
              </header>

              <div className="site-detail-page__form-grid">
                <label className="site-detail-page__field">
                  <span>Identity name</span>
                  <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
                </label>

                <label className="site-detail-page__field">
                  <span>OpenClaw endpoint</span>
                  <input value={draftDomain} onChange={(event) => setDraftDomain(event.target.value)} />
                </label>

                <label className="site-detail-page__field site-detail-page__field--textarea">
                  <span>Description</span>
                  <textarea
                    value={draftDescription}
                    onChange={(event) => setDraftDescription(event.target.value)}
                    placeholder="What this agent is allowed to do"
                  />
                </label>

                <div className="site-detail-page__preview" aria-label="Agent identity preview">
                  <span>Identity bundle</span>
                  <div className="site-detail-page__preview-card">
                    <Brand
                      className="site-detail-page__preview-brand"
                      label={normalizedDraftDomain || site.domain}
                      theme="light"
                    />
                    <strong>{normalizedDraftName || site.name}</strong>
                    <p>{previewDescription}</p>
                  </div>
                </div>
              </div>

              <section className="site-detail-page__section agent-identity-capabilities" aria-label="Provisioned real-world tools">
                {agentIdentityCapabilities.map(({ label, value, description, Icon }) => (
                  <article className="agent-identity-capabilities__item" key={label}>
                    <span className="agent-identity-capabilities__icon" aria-hidden="true">
                      <Icon size={17} strokeWidth={2.2} />
                    </span>
                    <div>
                      <strong>{label}</strong>
                      <span>{value}</span>
                      <small>{description}</small>
                    </div>
                  </article>
                ))}
              </section>

              {siteSaveError ? <p className="site-detail-panel__error">{siteSaveError}</p> : null}

              <section className="site-detail-panel__danger site-detail-page__section">
                <div>
                  <h3>Danger Zone</h3>
                  <p>Delete this identity, OpenClaw link tokens, API keys, generated docs, and interaction logs.</p>
                  {siteDeleteError ? <p className="site-detail-panel__error">{siteDeleteError}</p> : null}
                </div>
                <button
                  className="site-detail-panel__delete-site"
                  type="button"
                  onClick={() => void deleteSite()}
                  disabled={isDeletingSite}
                >
                  {isDeletingSite ? (
                    <Loader2 size={17} aria-hidden="true" />
                  ) : (
                    <DeleteMinusCircleIcon className="site-detail-page__delete-icon" />
                  )}
                  <span>{isDeletingSite ? "Deleting" : "Delete identity"}</span>
                </button>
              </section>
            </>
          ) : activeTab === "openclaw" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="siteDetailTitle">OpenClaw link</h1>
                </div>
              </header>

              <section className="site-detail-panel__receipt site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Identity layer receipt</h3>
                    <p>Use this demo receipt to verify the real-world tools attached to {site.name}.</p>
                  </div>
                  <div className="site-detail-page__section-actions">
                    <button
                      className="site-detail-page__section-action"
                      type="button"
                      onClick={copySnippet}
                    >
                      Copy receipt
                    </button>
                  </div>
                </div>
                <textarea readOnly value={buildIdentityReceipt(site)} spellCheck={false} />
              </section>

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>OpenClaw linking tokens</h3>
                    <p>Create a scoped token for an OpenClaw instance to confirm the Barkan identity skill install.</p>
                  </div>
                  <button
                    className="site-detail-page__section-action"
                    type="button"
                    onClick={createApiKey}
                    disabled={isCreatingApiKey}
                  >
                    {isCreatingApiKey ? "Creating" : createdApiKeySecret ? "Create another token" : "Create link token"}
                  </button>
                </div>
                {apiKeys.length > 0 ? (
                  <div className="site-detail-panel__api-key-list">
                    {apiKeys.map((apiKey) => (
                      <div className="site-detail-panel__api-key-row" key={apiKey.id}>
                        <div>
                          <strong>{apiKey.name}</strong>
                          <span>{apiKey.prefix}••••••••••••</span>
                        </div>
                        <small>
                          {apiKey.lastUsedAt ? `Used ${formatSiteRelativeTime(apiKey.lastUsedAt)}` : "Never used"}
                        </small>
                        <div className="site-detail-panel__api-key-row-actions">
                          {createdApiKeySecret?.apiKeyId === apiKey.id ? (
                            <button
                              className="site-detail-panel__copy-key"
                              type="button"
                              onClick={() => void copyApiKey(apiKey.id, createdApiKeySecret.secret)}
                            >
                              {copiedApiKeyId === apiKey.id ? (
                                <Check size={16} aria-hidden="true" />
                              ) : (
                                <Copy size={16} aria-hidden="true" />
                              )}
                              <span>{copiedApiKeyId === apiKey.id ? "Copied" : "Copy token"}</span>
                            </button>
                          ) : null}
                          <button
                            className="site-detail-panel__delete-key"
                            type="button"
                            aria-label={`Delete ${apiKey.name}`}
                            title="Delete link token"
                            onClick={() => void deleteApiKey(apiKey.id)}
                            disabled={deletingApiKeyId === apiKey.id}
                          >
                            {deletingApiKeyId === apiKey.id ? (
                              <Loader2 size={16} aria-hidden="true" />
                            ) : (
                              <DeleteMinusCircleIcon className="site-detail-page__delete-icon" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {apiKeyError ? <p className="site-detail-panel__error">{apiKeyError}</p> : null}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function SetupProgressStepper({
  activeStep,
  completedSteps,
  stepProgress,
  steps = onboardingSetupSteps
}: {
  activeStep: SetupProgressStep | null;
  completedSteps: Set<SetupProgressStep>;
  stepProgress: SetupStepProgress;
  steps?: Array<{ id: SetupProgressStep; label: string }>;
}) {
  const currentStepIndex = activeStep
    ? steps.findIndex((step) => step.id === activeStep)
    : Math.max(0, completedSteps.size - 1);
  const lineProgress = steps.length <= 1 ? (completedSteps.size > 0 ? 1 : 0) : Math.min(completedSteps.size, steps.length - 1) / (steps.length - 1);

  return (
    <div
      className="setup-progress"
      style={
        {
          "--setup-progress-step-count": steps.length,
          "--setup-progress-line-progress": lineProgress
        } as CSSProperties
      }
      aria-label="Setup progress"
    >
      {steps.map((step, index) => {
        const isCompleted = completedSteps.has(step.id);
        const isActive = activeStep === step.id;
        const state = isCompleted ? "complete" : isActive ? "active" : index < currentStepIndex ? "complete" : "pending";
        const progress = stepProgress[step.id];
        const circleProgress = isCompleted
          ? 1
          : progress && progress.total > 0
            ? Math.max(0, Math.min(1, progress.current / progress.total))
            : 0;

        return (
          <div className={`setup-progress__step setup-progress__step--${state}`} key={step.id}>
            <div
              className="setup-progress__circle"
              style={{ "--setup-progress-circle-progress": `${circleProgress}turn` } as CSSProperties}
            >
              {isCompleted ? <Check size={15} aria-hidden="true" /> : <span>{index + 1}</span>}
            </div>
            <span className="setup-progress__label">{step.label}</span>
            {progress?.label ? <small className="setup-progress__detail">{progress.label}</small> : null}
          </div>
        );
      })}
    </div>
  );
}
