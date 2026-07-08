import { Bot, Check, Copy, CreditCard, Mail, Phone, Server, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { billingApi } from "../api/billing";
import { agentsApi } from "../api/agents";
import type { Agent, CreateAgentResponse } from "../api/types";
import { Brand, getErrorMessage, requiredFieldMessage, type ToastNotificationInput } from "../shared";

type WizardStep = "identity" | "capabilities" | "review" | "token";
type RuntimeChoice = "openclaw" | "hermes" | "api";

const runtimeChoices: Array<{ id: RuntimeChoice; label: string; description: string; Icon: typeof Server }> = [
  { id: "openclaw", label: "OpenClaw", description: "Connect this identity to an OpenClaw runtime.", Icon: Server },
  { id: "hermes", label: "Hermes", description: "Use Barkan from a Hermes-capable agent.", Icon: Bot },
  { id: "api", label: "API", description: "Use the REST API, SDK, or MCP bridge directly.", Icon: Zap }
];

const tokenStoredKeyPrefix = "barkan-token-stored:";

export function AgentCreationWizard({
  onCancel,
  onCreated,
  onNotify
}: {
  onCancel: () => void;
  onCreated: (response: CreateAgentResponse) => void;
  onNotify: (notification: ToastNotificationInput) => void;
}) {
  const [step, setStep] = useState<WizardStep>("identity");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<RuntimeChoice>("openclaw");
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [phoneEnabled, setPhoneEnabled] = useState(false);
  const [phoneLocked, setPhoneLocked] = useState(true);
  const [nameError, setNameError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<CreateAgentResponse | null>(null);
  const [isTokenCopied, setIsTokenCopied] = useState(false);
  const normalizedName = name.trim();
  const normalizedDescription = description.trim();

  useEffect(() => {
    let cancelled = false;
    void billingApi.getAccount()
      .then((account) => {
        if (!cancelled) setPhoneLocked(account.plan === "free");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function goTo(nextStep: WizardStep) {
    if (nextStep !== "identity" && !normalizedName) {
      setNameError(requiredFieldMessage);
      return;
    }
    setNameError("");
    setStep(nextStep);
  }

  async function createAgent(event: FormEvent) {
    event.preventDefault();
    if (!normalizedName) {
      setNameError(requiredFieldMessage);
      return;
    }

    setIsCreating(true);
    setSubmitError("");
    try {
      const response = await agentsApi.create({
        name: normalizedName,
        description: normalizedDescription || undefined,
        runtime,
        capabilities: {
          email: emailEnabled,
          phone: phoneEnabled
        },
        approvalMode: "always"
      });
      setCreated(response);
      setStep("token");
      onCreated(response);
    } catch (error) {
      setSubmitError(getErrorMessage(error, "Could not create agent identity"));
    } finally {
      setIsCreating(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    await navigator.clipboard.writeText(created.identityToken.secret);
    setIsTokenCopied(true);
    onNotify({ title: "Identity token copied" });
  }

  function confirmStored() {
    if (!created) return;
    window.localStorage.setItem(`${tokenStoredKeyPrefix}${created.agent.id}`, "true");
    onCancel();
  }

  return (
    <main className="site-onboarding-page" aria-label="Create agent identity">
      <button className="site-onboarding-page__close" type="button" aria-label="Close" onClick={onCancel}>
        <X size={18} aria-hidden="true" />
      </button>
      <div className="site-onboarding-page__panel site-onboarding-page__panel--active">
        <Brand />

        {step === "identity" ? (
          <form className="site-onboarding-page__form" onSubmit={(event) => { event.preventDefault(); goTo("capabilities"); }}>
            <header className="site-onboarding-page__header">
              <h1>Name this agent identity</h1>
              <p>Choose how this AI worker will connect to Barkan.</p>
            </header>
            <label className="site-onboarding-page__field">
              <span>Name</span>
              <input value={name} onChange={(event) => { setName(event.target.value); setNameError(""); }} />
              {nameError ? <small role="alert">{nameError}</small> : null}
            </label>
            <label className="site-onboarding-page__field">
              <span>Description</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
            </label>
            <div className="site-onboarding-page__choice-grid">
              {runtimeChoices.map(({ id, label, description: runtimeDescription, Icon }) => (
                <button
                  className={`site-onboarding-page__choice${runtime === id ? " site-onboarding-page__choice--selected" : ""}`}
                  key={id}
                  type="button"
                  onClick={() => setRuntime(id)}
                >
                  <Icon size={20} aria-hidden="true" />
                  <span>{label}</span>
                  <small>{runtimeDescription}</small>
                </button>
              ))}
            </div>
            <button className="site-onboarding-page__submit" type="submit">Continue</button>
          </form>
        ) : null}

        {step === "capabilities" ? (
          <section className="site-onboarding-page__form">
            <header className="site-onboarding-page__header">
              <h1>Choose real-world tools</h1>
              <p>Email and phone are provisioned under owner policy. Payment cards are coming soon.</p>
            </header>
            <CapabilityToggle
              checked={emailEnabled}
              description="Provision a dedicated email address for outbound and inbound mail."
              icon={<Mail size={20} aria-hidden="true" />}
              label="Email"
              onChange={setEmailEnabled}
            />
            <CapabilityToggle
              checked={phoneEnabled}
              description={phoneLocked ? "Phone unlocks on paid plans. You can add it after upgrading." : "Provision a phone number for calls and SMS."}
              disabled={phoneLocked}
              icon={<Phone size={20} aria-hidden="true" />}
              label={phoneLocked ? "Phone - upgrade required" : "Phone"}
              onChange={(checked) => setPhoneEnabled(phoneLocked ? false : checked)}
            />
            <div className="site-onboarding-page__choice site-onboarding-page__choice--disabled" title="Controlled agent spending is on the roadmap">
              <CreditCard size={20} aria-hidden="true" />
              <span>Payment card</span>
              <small>Coming soon</small>
            </div>
            <div className="site-onboarding-page__actions">
              <button type="button" onClick={() => goTo("identity")}>Back</button>
              <button className="site-onboarding-page__submit" type="button" onClick={() => goTo("review")}>Review</button>
            </div>
          </section>
        ) : null}

        {step === "review" ? (
          <form className="site-onboarding-page__form" onSubmit={createAgent}>
            <header className="site-onboarding-page__header">
              <h1>Review & create</h1>
              <p>{normalizedName} will be created with {runtimeLabel(runtime)} instructions.</p>
            </header>
            <div className="site-onboarding-page__receipt">
              <span>Name: {normalizedName}</span>
              <span>Runtime: {runtimeLabel(runtime)}</span>
              <span>Email: {emailEnabled ? "Enabled" : "Off"}</span>
              <span>Phone: {phoneEnabled ? "Enabled" : "Off"}</span>
              <span>Payment card: Coming soon</span>
            </div>
            {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
            <div className="site-onboarding-page__actions">
              <button type="button" onClick={() => goTo("capabilities")}>Back</button>
              <button className="site-onboarding-page__submit" type="submit" disabled={isCreating}>
                {isCreating ? "Creating..." : "Create identity"}
              </button>
            </div>
          </form>
        ) : null}

        {step === "token" && created ? (
          <section className="site-onboarding-page__form">
            <header className="site-onboarding-page__header">
              <h1>Store this identity token</h1>
              <p>This secret is shown once. Keep it in the agent runtime environment.</p>
            </header>
            <div className="site-onboarding-page__token">
              <code>{isTokenCopied || tokenWasStored(created.agent.id) ? maskToken(created.identityToken.secret) : created.identityToken.secret}</code>
              <button type="button" onClick={copyToken}>
                <Copy size={16} aria-hidden="true" />
                <span>{isTokenCopied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <RuntimeInstructions agent={created.agent} tokenPrefix={created.identityToken.prefix} />
            <button className="site-onboarding-page__submit" type="button" onClick={confirmStored}>
              <Check size={16} aria-hidden="true" />
              <span>I stored it</span>
            </button>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function CapabilityToggle({
  checked,
  description,
  disabled = false,
  icon,
  label,
  onChange
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`site-onboarding-page__choice${checked ? " site-onboarding-page__choice--selected" : ""}${disabled ? " site-onboarding-page__choice--disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {icon}
      <span>{label}</span>
      <small>{description}</small>
    </label>
  );
}

function RuntimeInstructions({ agent, tokenPrefix }: { agent: Agent; tokenPrefix: string }) {
  const runtimeName = runtimeLabel(agent.runtime === "other" || agent.runtime === null ? "api" : agent.runtime);
  const envText = useMemo(
    () => `BARKAN_API_URL=${window.location.origin}\nBARKAN_IDENTITY_TOKEN=${tokenPrefix}_...`,
    [tokenPrefix]
  );
  const pairText = "npx @barkan/mcp --pair";
  const sdkText = `import { BarkanClient } from "@barkan/sdk";

const barkan = new BarkanClient({
  apiUrl: process.env.BARKAN_API_URL,
  token: process.env.BARKAN_IDENTITY_TOKEN
});`;

  return (
    <div className="site-onboarding-page__receipt">
      <strong>{runtimeName} connection</strong>
      <code>{envText}</code>
      <code>{pairText}</code>
      <code>{sdkText}</code>
      <span>Use the pair shortcut for MCP, or paste the env lines into OpenClaw, Hermes, or SDK config.</span>
    </div>
  );
}

function runtimeLabel(runtime: RuntimeChoice): string {
  if (runtime === "openclaw") return "OpenClaw";
  if (runtime === "hermes") return "Hermes";
  return "API";
}

function tokenWasStored(agentId: string): boolean {
  return window.localStorage.getItem(`${tokenStoredKeyPrefix}${agentId}`) === "true";
}

function maskToken(token: string): string {
  return `${token.slice(0, 10)}...stored`;
}
