import React, { useEffect, useId, useState, type ChangeEvent } from "react";
import { Loader2, LogOut, X } from "lucide-react";
import { api, type Site, type User } from "../api";
import { billingApi, type BillingAccountView, type BillingPlanName, type BillingPlanView, type BillingUsageView, type EmailDomainStatusView, type OpsStatusView } from "../api/billing";
import { ApiClientError } from "../api/client";
import { FloatingField, getErrorMessage, profileAvatarAcceptedTypes, profileAvatarMaxBytes, type ToastNotificationInput, type UserSettingsSection } from "../shared";
import { BillingSettingsContent } from "./BillingSettingsSection";
import { getDashboardChatGreetingName } from "./ChatPage";

export function UserSettingsPage({
  user,
  activeSection,
  sites,
  onSectionChange,
  onUserUpdated,
  onNotify,
  onBack,
  onLogout
}: {
  user: User;
  activeSection: UserSettingsSection;
  sites: Site[];
  onSectionChange: (section: UserSettingsSection) => void;
  onUserUpdated: (user: User) => void;
  onNotify: (notification: ToastNotificationInput) => void;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName ?? getDashboardChatGreetingName(user.email));
  const [email, setEmail] = useState(user.email);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [avatarInputKey, setAvatarInputKey] = useState(0);
  const [productEmails, setProductEmails] = useState(user.notificationPreferences.productEmails);
  const [identityEmails, setIdentityEmails] = useState(user.notificationPreferences.identityEmails);
  const [securityEmails, setSecurityEmails] = useState(user.notificationPreferences.securityEmails);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [billingAccount, setBillingAccount] = useState<BillingAccountView | null>(null);
  const [billingPlans, setBillingPlans] = useState<BillingPlanView[]>([]);
  const [billingUsage, setBillingUsage] = useState<BillingUsageView | null>(null);
  const [emailDomain, setEmailDomain] = useState<EmailDomainStatusView | null>(null);
  const [opsStatus, setOpsStatus] = useState<OpsStatusView | null>(null);
  const [isBillingLoading, setIsBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [billingBlocks, setBillingBlocks] = useState<string[]>([]);
  const avatarInputId = useId();
  const joinedDate = formatProfileDate(user.createdAt);
  const initials = getUserInitials(displayName, email);
  const normalizedDisplayName = displayName.trim();
  const normalizedEmail = email.trim();
  const normalizedAvatarUrl = avatarUrl.trim() || null;
  const currentAvatarUrl = user.avatarUrl ?? null;
  const hasProfileChanges =
    normalizedDisplayName !== (user.displayName ?? getDashboardChatGreetingName(user.email)) ||
    normalizedEmail !== user.email ||
    normalizedAvatarUrl !== currentAvatarUrl;
  const hasNotificationChanges =
    productEmails !== user.notificationPreferences.productEmails ||
    identityEmails !== user.notificationPreferences.identityEmails ||
    securityEmails !== user.notificationPreferences.securityEmails;

  useEffect(() => {
    setDisplayName(user.displayName ?? getDashboardChatGreetingName(user.email));
    setEmail(user.email);
    setAvatarUrl(user.avatarUrl ?? "");
    setProductEmails(user.notificationPreferences.productEmails);
    setIdentityEmails(user.notificationPreferences.identityEmails);
    setSecurityEmails(user.notificationPreferences.securityEmails);
  }, [user]);

  useEffect(() => {
    if (activeSection !== "billing") return;
    void loadBillingSection();
    if (new URLSearchParams(window.location.search).get("checkout") !== "success") return;
    const timers = [2000, 5000, 10_000].map((delay) => window.setTimeout(() => void loadBillingSection(), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [activeSection]);

  async function loadBillingSection() {
    setIsBillingLoading(true);
    setBillingError("");
    try {
      const [account, plans, usage, domain, status] = await Promise.all([
        billingApi.getAccount(),
        billingApi.getPlans(),
        billingApi.getUsage(),
        billingApi.getEmailDomain(),
        billingApi.getOpsStatus()
      ]);
      setBillingAccount(account);
      setBillingPlans(plans.plans);
      setBillingUsage(usage);
      setEmailDomain(domain.domain);
      setOpsStatus(status);
    } catch (error) {
      setBillingError(getErrorMessage(error, "Could not load billing"));
    } finally {
      setIsBillingLoading(false);
    }
  }

  async function openBillingPortal() {
    setBillingError("");
    try {
      const response = await billingApi.portal();
      window.location.assign(response.portalUrl);
    } catch (error) {
      setBillingError(getErrorMessage(error, "Could not open billing portal"));
    }
  }

  async function choosePlan(plan: BillingPlanName) {
    if (plan === "free") return;
    setBillingBlocks([]);
    setBillingError("");
    try {
      const response = await billingApi.checkout(plan);
      window.location.assign(response.checkoutUrl);
    } catch (error) {
      const blocks = error instanceof ApiClientError && Array.isArray((error.details as { blocking?: unknown }).blocking)
        ? ((error.details as { blocking: unknown[] }).blocking.filter((item): item is string => typeof item === "string"))
        : [];
      if (blocks.length > 0) setBillingBlocks(blocks);
      setBillingError(getErrorMessage(error, "Could not start checkout"));
    }
  }

  async function copyDnsRecord(record: EmailDomainStatusView["records"][number]) {
    await navigator.clipboard?.writeText(`${record.type} ${record.name} ${record.value}`);
    onNotify({ title: "DNS record copied" });
  }

  async function saveProfileSettings() {
    if (!normalizedDisplayName || !normalizedEmail) {
      setProfileError("Display name and email are required.");
      return;
    }

    setIsSavingProfile(true);
    setProfileError("");

    try {
      const response = await api.updateProfile({
        displayName: normalizedDisplayName,
        email: normalizedEmail,
        avatarUrl: normalizedAvatarUrl
      });
      onUserUpdated(response.user);
      onNotify({
        title: "Profile saved"
      });
    } catch (error) {
      setProfileError(getErrorMessage(error, "Could not save profile"));
    } finally {
      setIsSavingProfile(false);
    }
  }

  function updateAvatarFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!profileAvatarAcceptedTypes.has(file.type)) {
      setProfileError("Choose a PNG, JPEG, WebP, or GIF image.");
      setAvatarInputKey((key) => key + 1);
      return;
    }

    if (file.size > profileAvatarMaxBytes) {
      setProfileError("Profile picture must be under 256 KB.");
      setAvatarInputKey((key) => key + 1);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setProfileError("Could not read that image.");
        return;
      }

      setAvatarUrl(reader.result);
      setProfileError("");
    };
    reader.onerror = () => setProfileError("Could not read that image.");
    reader.readAsDataURL(file);
  }

  function removeAvatar() {
    setAvatarUrl("");
    setAvatarInputKey((key) => key + 1);
    setProfileError("");
  }

  async function saveNotificationSettings() {
    setIsSavingNotifications(true);
    setNotificationsError("");

    try {
      const response = await api.updateNotificationPreferences({
        productEmails,
        identityEmails,
        securityEmails
      });
      onUserUpdated(response.user);
      onNotify({
        title: "Notification preferences saved"
      });
    } catch (error) {
      setNotificationsError(getErrorMessage(error, "Could not save notification preferences"));
    } finally {
      setIsSavingNotifications(false);
    }
  }

  async function savePasswordSettings() {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError("All password fields are required.");
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }

    setIsSavingPassword(true);
    setPasswordError("");

    try {
      await api.updatePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setIsPasswordModalOpen(false);
      onNotify({
        title: "Password updated"
      });
    } catch (error) {
      setPasswordError(getErrorMessage(error, "Could not update password"));
    } finally {
      setIsSavingPassword(false);
    }
  }

  function openPasswordModal() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setIsPasswordModalOpen(true);
  }

  function closePasswordModal() {
    if (isSavingPassword) {
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError("");
    setIsPasswordModalOpen(false);
  }

  return (
    <>
      <section className="site-detail-page user-settings-page dashboard-page__workspace" aria-labelledby="userSettingsTitle">
        <div className="site-detail-page__shell">
          <aside className="site-detail-page__sidebar" aria-label="Profile settings sections">
            <button className="site-detail-page__back" type="button" onClick={onBack} aria-label="Back to identities">
              <BackChevronIcon />
            </button>

            <nav className="site-detail-page__tabs" role="tablist" aria-label="Profile settings">
            <UserSettingsTab
              section="profile"
              activeSection={activeSection}
              label="Profile"
              icon="profile"
              onSectionChange={onSectionChange}
            />
            <UserSettingsTab
              section="security"
              activeSection={activeSection}
              label="Security"
              icon="security"
              onSectionChange={onSectionChange}
            />
            <UserSettingsTab
              section="notifications"
              activeSection={activeSection}
              label="Notifications"
              icon="notifications"
              onSectionChange={onSectionChange}
            />
            <UserSettingsTab
              section="billing"
              activeSection={activeSection}
              label="Billing"
              icon="billing"
              onSectionChange={onSectionChange}
            />
            </nav>
          </aside>

          <div
            className="site-detail-page__content"
            key={activeSection}
            id={`user-settings-${activeSection}-panel`}
            role="tabpanel"
            aria-labelledby={`user-settings-${activeSection}-tab`}
          >
          {activeSection === "profile" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Profile</h1>
                </div>
                <button
                  className={`site-detail-page__save${isSavingProfile ? " site-detail-page__save--saving" : ""}`}
                  type="button"
                  onClick={() => void saveProfileSettings()}
                  disabled={isSavingProfile || !normalizedDisplayName || !normalizedEmail || !hasProfileChanges}
                >
                  {isSavingProfile ? <Loader2 size={15} strokeWidth={3.2} aria-hidden="true" /> : <span>Save</span>}
                </button>
              </header>

              <div className="site-detail-page__form-grid user-settings-page__profile-grid">
                <div className="site-detail-page__preview user-settings-page__profile-preview" aria-label="Profile preview">
                  <span>Preview</span>
                  <div className="site-detail-page__preview-card user-settings-page__profile-card">
                    <div className="user-settings-page__avatar user-settings-page__avatar--large" aria-hidden="true">
                      {avatarUrl ? <img src={avatarUrl} alt="" /> : initials}
                    </div>
                    <strong>{displayName || email}</strong>
                    <p>{email}</p>
                    <div className="user-settings-page__avatar-actions">
                      <label className="user-settings-page__avatar-upload" htmlFor={avatarInputId}>
                        <input
                          key={avatarInputKey}
                          id={avatarInputId}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={updateAvatarFromFile}
                        />
                        <span>{avatarUrl ? "Change photo" : "Upload photo"}</span>
                      </label>
                      {avatarUrl ? (
                        <button className="user-settings-page__avatar-remove" type="button" onClick={removeAvatar}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <label className="site-detail-page__field">
                  <span>Display name</span>
                  <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>

                <label className="site-detail-page__field">
                  <span>Email</span>
                  <input value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
              </div>

              {profileError ? <p className="site-detail-panel__error">{profileError}</p> : null}

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Account details</h3>
                    <p>Basic information used across the Barkan dashboard.</p>
                  </div>
                </div>
                <div className="user-settings-page__info-grid">
                  <UserSettingsInfo label="User ID" value={user.id} />
                  <UserSettingsInfo label="Created" value={joinedDate} />
                  <UserSettingsInfo label="Agent identities" value={`${sites.length}`} />
                </div>
              </section>
            </>
          ) : activeSection === "security" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Security</h1>
                </div>
              </header>

              <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Password</h3>
                    <p>Update the password used to sign in to this dashboard.</p>
                  </div>
                  <button
                    className="site-detail-page__section-action"
                    type="button"
                    onClick={openPasswordModal}
                  >
                    Change password
                  </button>
                </div>
              </section>

              <section className="site-detail-panel__api-key site-detail-page__section">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Active session</h3>
                    <p>This browser is signed in with an HTTP-only session cookie.</p>
                  </div>
                  <button className="site-detail-page__section-action" type="button" onClick={onLogout}>
                    Sign out
                  </button>
                </div>
              </section>
            </>
          ) : activeSection === "notifications" ? (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Notifications</h1>
                </div>
                <button
                  className={`site-detail-page__save${isSavingNotifications ? " site-detail-page__save--saving" : ""}`}
                  type="button"
                  onClick={() => void saveNotificationSettings()}
                  disabled={isSavingNotifications || !hasNotificationChanges}
                >
                  {isSavingNotifications ? <Loader2 size={15} strokeWidth={3.2} aria-hidden="true" /> : <span>Save</span>}
                </button>
              </header>

              <section className="site-detail-panel__api-key site-detail-page__section site-detail-page__section--flush">
                <div className="site-detail-page__section-heading">
                  <div>
                    <h3>Email preferences</h3>
                    <p>Choose which dashboard updates should reach your inbox.</p>
                  </div>
                </div>
                <div className="user-settings-page__toggle-list">
                  <UserSettingsToggle
                    label="Product updates"
                    description="New dashboard capabilities, identity improvements, and release notes."
                    checked={productEmails}
                    onChange={setProductEmails}
                  />
                  <UserSettingsToggle
                    label="Identity status"
                    description="OpenClaw links, identity setup, and tool provisioning updates."
                    checked={identityEmails}
                    onChange={setIdentityEmails}
                  />
                  <UserSettingsToggle
                    label="Security alerts"
                    description="Sign-in, session, and credential-related notices."
                    checked={securityEmails}
                    onChange={setSecurityEmails}
                  />
                </div>
                {notificationsError ? <p className="site-detail-panel__error">{notificationsError}</p> : null}
              </section>
            </>
          ) : (
            <>
              <header className="site-detail-page__header">
                <div>
                  <h1 id="userSettingsTitle">Billing</h1>
                </div>
              </header>

              <BillingSettingsContent
                isLoading={isBillingLoading}
                error={billingError}
                account={billingAccount}
                plans={billingPlans}
                usage={billingUsage}
                emailDomain={emailDomain}
                opsStatus={opsStatus}
                billingBlocks={billingBlocks}
                onPortal={() => void openBillingPortal()}
                onChoosePlan={(plan) => void choosePlan(plan)}
                onCopyRecord={(record) => void copyDnsRecord(record)}
              />
            </>
          )}
          </div>
        </div>
      </section>

      {isPasswordModalOpen ? (
        <div
          className="user-settings-page__modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closePasswordModal();
            }
          }}
        >
          <form
            className="user-settings-page__password-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="passwordModalTitle"
            onSubmit={(event) => {
              event.preventDefault();
              void savePasswordSettings();
            }}
          >
            <header className="user-settings-page__modal-header">
              <div>
                <h2 id="passwordModalTitle">Change password</h2>
                <p>Update the password used to sign in to this dashboard.</p>
              </div>
              <button className="user-settings-page__modal-close" type="button" onClick={closePasswordModal} aria-label="Close password dialog">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="user-settings-page__password-fields">
              <label className="site-detail-page__field">
                <span>Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </label>
              <label className="site-detail-page__field">
                <span>New password</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="site-detail-page__field">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>

            {passwordError ? <p className="site-detail-panel__error">{passwordError}</p> : null}

            <footer className="user-settings-page__modal-actions">
              <button className="user-settings-page__modal-secondary" type="button" onClick={closePasswordModal} disabled={isSavingPassword}>
                Cancel
              </button>
              <button className="site-detail-page__section-action" type="submit" disabled={isSavingPassword}>
                {isSavingPassword ? "Updating" : "Update password"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </>
  );
}

function UserSettingsTab({
  section,
  activeSection,
  label,
  icon,
  onSectionChange
}: {
  section: UserSettingsSection;
  activeSection: UserSettingsSection;
  label: string;
  icon: "profile" | "security" | "notifications" | "billing";
  onSectionChange: (section: UserSettingsSection) => void;
}) {
  return (
    <button
      className="site-detail-page__tab"
      id={`user-settings-${section}-tab`}
      type="button"
      role="tab"
      aria-label={label}
      aria-selected={activeSection === section}
      aria-controls={`user-settings-${section}-panel`}
      onClick={() => onSectionChange(section)}
    >
      <SiteSettingsCategoryIcon icon={icon} />
      <span>{label}</span>
    </button>
  );
}

function UserSettingsInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="user-settings-page__info-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UserSettingsMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="user-settings-page__metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function UserSettingsToggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="user-settings-page__toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="user-settings-page__toggle-control" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

export function getUserInitials(displayName: string, email: string): string {
  const source = displayName.trim() || email;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? email.charAt(0);
  const second = parts.length > 1 ? parts[1]?.charAt(0) : "";
  return `${first}${second}`.toUpperCase();
}

function formatProfileDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

export function SiteSettingsCategoryIcon({
  icon
}: {
  icon:
    | "general"
    | "openclaw"
    | "phone"
    | "act-on-behalf"
    | "email"
    | "profile"
    | "security"
    | "notifications"
    | "billing";
}) {
  if (icon === "profile") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 10.35a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0 1.65c-4.1 0-7.25 2.08-7.25 4.64 0 .78.63 1.41 1.41 1.41h11.68c.78 0 1.41-.63 1.41-1.41C17.25 14.08 14.1 12 10 12Z" />
      </svg>
    );
  }

  if (icon === "security") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 1.55 3.2 4.1v4.94c0 4.23 2.85 8.18 6.8 9.41 3.95-1.23 6.8-5.18 6.8-9.41V4.1L10 1.55Zm2.38 7.75-2.94 3.35a.82.82 0 0 1-1.21.03L6.74 11.2a.84.84 0 0 1 1.19-1.19l.85.85 2.34-2.67a.84.84 0 1 1 1.26 1.11Z" />
      </svg>
    );
  }

  if (icon === "notifications") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 18.25a2.16 2.16 0 0 0 2.05-1.5h-4.1A2.16 2.16 0 0 0 10 18.25ZM4.1 14.95h11.8c.67 0 1.05-.76.65-1.3l-.9-1.22V8.1a5.65 5.65 0 1 0-11.3 0v4.33l-.9 1.22c-.4.54-.02 1.3.65 1.3Z" />
      </svg>
    );
  }

  if (icon === "billing") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3.25 4.25A2.25 2.25 0 0 1 5.5 2h9a2.25 2.25 0 0 1 2.25 2.25v11.5A2.25 2.25 0 0 1 14.5 18h-9a2.25 2.25 0 0 1-2.25-2.25V4.25Zm2.4 2.3h8.7V5.1h-8.7v1.45Zm0 3.1h2.8V8.2h-2.8v1.45Zm4.95 0h3.75V8.2H10.6v1.45Zm-4.95 3.15h2.8v-1.45h-2.8v1.45Zm4.95 0h3.75v-1.45H10.6v1.45Z" />
      </svg>
    );
  }

  if (icon === "general") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.57 1.75h2.86l.52 2.18c.47.15.92.34 1.34.56l1.91-1.18 2.02 2.02-1.18 1.91c.22.42.41.87.56 1.34l2.18.52v2.86l-2.18.52c-.15.47-.34.92-.56 1.34l1.18 1.91-2.02 2.02-1.91-1.18c-.42.22-.87.41-1.34.56l-.52 2.18H8.57l-.52-2.18a7.1 7.1 0 0 1-1.34-.56L4.8 17.75l-2.02-2.02 1.18-1.91a7.1 7.1 0 0 1-.56-1.34l-2.18-.52V9.1l2.18-.52c.15-.47.34-.92.56-1.34L2.78 5.33 4.8 3.31l1.91 1.18c.42-.22.87-.41 1.34-.56l.52-2.18Zm1.43 5.8a2.45 2.45 0 1 0 0 4.9 2.45 2.45 0 0 0 0-4.9Z" />
      </svg>
    );
  }

  if (icon === "openclaw") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10.5 3A1.501 1.501 0 0 0 9 4.5h6A1.5 1.5 0 0 0 13.5 3h-3Zm-2.693.178A3 3 0 0 1 10.5 1.5h3a3 3 0 0 1 2.694 1.678c.497.042.992.092 1.486.15 1.497.173 2.57 1.46 2.57 2.929V19.5a3 3 0 0 1-3 3H6.75a3 3 0 0 1-3-3V6.257c0-1.47 1.073-2.756 2.57-2.93.493-.057.989-.107 1.487-.15Z"
          clipRule="evenodd"
        />
      </svg>
    );
  }

  if (icon === "act-on-behalf") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.8 4.74c0-.76.84-1.22 1.48-.8l5.86 3.9c.55.37.55 1.18 0 1.54l-5.86 3.9a.96.96 0 0 1-1.48-.8V4.74Zm8.08 0c0-.76.85-1.22 1.48-.8l5.86 3.9c.55.37.55 1.18 0 1.54l-5.86 3.9a.96.96 0 0 1-1.48-.8V4.74Z" />
      </svg>
    );
  }

  if (icon === "phone") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5.32 2.1c.62-.29 1.36-.06 1.71.52l1.2 2c.31.52.25 1.18-.16 1.63l-.8.89a.46.46 0 0 0-.08.5 9.03 9.03 0 0 0 4.15 4.15.46.46 0 0 0 .5-.08l.89-.8c.45-.41 1.11-.47 1.63-.16l2 1.2c.58.35.81 1.09.52 1.71l-.9 1.94c-.29.62-.92 1-1.6.96C7.92 16.17 3.83 12.08 3.44 5.62c-.04-.68.34-1.31.96-1.6l.92-.42Z" />
      </svg>
    );
  }

  if (icon === "email") {
    return (
      <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h12a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-9Zm1.86-.1 5.64 4.02 5.64-4.02H4.36Zm11.14 1.1-5.07 3.61a1 1 0 0 1-1.16 0L4.2 6.5v8H15.8v-8Z" />
      </svg>
    );
  }

  return (
    <svg className="site-detail-page__category-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11.42 1.52c.65.17.99.88.71 1.49L9.75 8.2h5.02c.91 0 1.38 1.09.75 1.75l-7.67 8.05c-.48.5-1.32.04-1.15-.63l1.43-5.57H4.97c-.79 0-1.29-.84-.92-1.54l6.18-8.27c.24-.4.72-.59 1.19-.47Z" />
    </svg>
  );
}

function DeleteMinusCircleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.5 4.47795V4.70495C17.799 4.82373 19.0927 4.99454 20.378 5.21695C20.4751 5.23376 20.5678 5.26952 20.6511 5.32218C20.7343 5.37485 20.8063 5.4434 20.8631 5.52391C20.9198 5.60441 20.9601 5.69531 20.9817 5.7914C21.0033 5.88749 21.0058 5.9869 20.989 6.08395C20.9722 6.181 20.9364 6.27378 20.8838 6.35701C20.8311 6.44023 20.7626 6.51227 20.682 6.56901C20.6015 6.62575 20.5106 6.66607 20.4146 6.68768C20.3185 6.70929 20.2191 6.71176 20.122 6.69495L19.913 6.65995L18.908 19.7299C18.8501 20.4835 18.5098 21.1875 17.9553 21.701C17.4008 22.2146 16.6728 22.4999 15.917 22.4999H8.08401C7.3282 22.4999 6.60026 22.2146 6.04573 21.701C5.4912 21.1875 5.15095 20.4835 5.09301 19.7299L4.08701 6.65995L3.87801 6.69495C3.78096 6.71176 3.68155 6.70929 3.58546 6.68768C3.48937 6.66607 3.39847 6.62575 3.31796 6.56901C3.15537 6.45443 3.04495 6.27994 3.01101 6.08395C2.97706 5.88795 3.02236 5.6865 3.13694 5.52391C3.25153 5.36131 3.42601 5.2509 3.62201 5.21695C4.90727 4.99427 6.20099 4.82347 7.50001 4.70495V4.47795C7.50001 2.91395 8.71301 1.57795 10.316 1.52695C11.4387 1.49102 12.5623 1.49102 13.685 1.52695C15.288 1.57795 16.5 2.91395 16.5 4.47795ZM10.364 3.02595C11.4547 2.99106 12.5463 2.99106 13.637 3.02595C14.39 3.04995 15 3.68395 15 4.47795V4.59095C13.0018 4.4696 10.9982 4.4696 9.00001 4.59095V4.47795C9.00001 3.68395 9.60901 3.04995 10.364 3.02595Z"
        clipRule="evenodd"
        fill="currentColor"
      />
    </svg>
  );
}

export function BackChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="6" height="9" viewBox="0 0 6 9" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4.25 7.5L1 4.25L4.25 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
