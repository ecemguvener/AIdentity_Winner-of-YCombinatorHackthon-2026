import { Bot, Check, Copy, CreditCard, KeyRound, Mail, Phone, Server, X, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { billingApi } from "../api/billing";
import { agentsApi } from "../api/agents";
import type { Agent, CreateAgentResponse } from "../api/types";
import { Brand, getErrorMessage, requiredFieldMessage, type ToastNotificationInput } from "../shared";

type WizardStep = "identity" | "capabilities" | "review" | "token";
type RuntimeChoice = "openclaw" | "hermes" | "api";

const wizardSteps: Array<{ id: WizardStep; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "capabilities", label: "Tools" },
  { id: "review", label: "Review" },
  { id: "token", label: "Connect" }
];

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
  const [emailEnabled] = useState(true);
  const [phoneLocked, setPhoneLocked] = useState(true);
  const [nameError, setNameError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<CreateAgentResponse | null>(null);
  const [isTokenCopied, setIsTokenCopied] = useState(false);
  const [isOpenClawPromptCopied, setIsOpenClawPromptCopied] = useState(false);
  const normalizedName = name.trim();
  const normalizedDescription = description.trim();
  const activeStepIndex = wizardSteps.findIndex((item) => item.id === step);

  useEffect(() => {
    let cancelled = false;
    void billingApi.getAccount()
      .then((account) => {
        if (cancelled) return;
        setPhoneLocked(account.plan === "free");
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
    setSubmitError("");
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
      const input = {
        name: normalizedName,
        description: normalizedDescription || undefined,
        runtime,
        capabilities: { email: emailEnabled, phone: false },
        approvalMode: "always" as const
      };
      const response = await agentsApi.create(input);
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

  async function copyOpenClawPrompt() {
    if (!created) return;
    await navigator.clipboard.writeText(buildOpenClawSetupPrompt({
      agent: created.agent,
      apiUrl: window.location.origin,
      token: created.identityToken.secret
    }));
    setIsOpenClawPromptCopied(true);
    onNotify({ title: "OpenClaw prompt copied" });
  }

  function confirmStored() {
    if (!created) return;
    window.localStorage.setItem(`${tokenStoredKeyPrefix}${created.agent.id}`, "true");
    onCancel();
  }

  return (
    <main className="site-onboarding-page" aria-label="Create agent identity">
      <div className="site-onboarding-page__canvas">
        <div className="site-onboarding-page__dark-plane" aria-hidden="true" />
        <div className="site-onboarding-page__board">
          <Brand className="site-onboarding-page__brand" />
          <div className="site-onboarding-page__progress" aria-hidden="true">
            {wizardSteps.map((item, index) => (
              <span className={`site-onboarding-page__progress-step${index <= activeStepIndex ? " site-onboarding-page__progress-step--active" : ""}`} key={item.id} />
            ))}
          </div>
          <button className="site-onboarding-page__close" type="button" aria-label="Close" onClick={onCancel}>
            <X size={18} aria-hidden="true" />
          </button>

          <div className={`site-onboarding-page__flow site-onboarding-page__flow--${step}${step === "token" ? " site-onboarding-page__flow--completion" : " site-onboarding-page__flow--compact"}`}>
            <div className="site-onboarding-page__stage">
              <div className={`site-onboarding-page__completion-backdrop${step === "token" ? " site-onboarding-page__completion-backdrop--active" : ""}`} aria-hidden="true" />
              <div className="site-onboarding-page__panel site-onboarding-page__panel--active">
                {step === "identity" ? (
                  <form className="site-onboarding-page__form" onSubmit={(event) => { event.preventDefault(); goTo("capabilities"); }}>
                    <header className="site-onboarding-page__header site-onboarding-page__sequence-item" style={sequenceStyle(0)}>
                      <h1>Name this agent identity</h1>
                      <p>Choose how this AI worker will connect to Barkan.</p>
                    </header>
                    <label className="site-onboarding-page__field site-onboarding-page__sequence-item" style={sequenceStyle(1)}>
                      <span>Name</span>
                      <input value={name} onChange={(event) => { setName(event.target.value); setNameError(""); }} autoFocus />
                      {nameError ? <small role="alert">{nameError}</small> : null}
                    </label>
                    <label className="site-onboarding-page__field site-onboarding-page__sequence-item" style={sequenceStyle(2)}>
                      <span>Description</span>
                      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
                    </label>
                    <div className="site-onboarding-page__mode-grid site-onboarding-page__sequence-item" style={sequenceStyle(3)}>
                      {runtimeChoices.map(({ id, label, description: runtimeDescription, Icon }) => (
                        <button
                          className={`site-onboarding-page__mode-card${runtime === id ? " site-onboarding-page__mode-card--active" : ""}`}
                          key={id}
                          type="button"
                          onClick={() => setRuntime(id)}
                        >
                          <Icon size={18} aria-hidden="true" />
                          <strong>{label}</strong>
                          <span>{runtimeDescription}</span>
                        </button>
                      ))}
                    </div>
                    <button className="site-onboarding-page__submit site-onboarding-page__sequence-item" style={sequenceStyle(4)} type="submit">
                      Continue
                    </button>
                  </form>
                ) : null}

                {step === "capabilities" ? (
                  <section className="site-onboarding-page__form">
                    <header className="site-onboarding-page__header site-onboarding-page__sequence-item" style={sequenceStyle(0)}>
                      <h1>Choose real-world tools</h1>
                      <p>Barkan creates email now. Phone stays off until you enable it from the identity page.</p>
                    </header>
                    <div className="agent-identity-capabilities agent-identity-capabilities--onboarding site-onboarding-page__sequence-item" style={sequenceStyle(1)}>
                      <CapabilitySummary icon={Mail} label="Email" value={emailEnabled ? "Provisioned on create" : "Off"} />
                      <CapabilitySummary icon={Phone} label="Phone" value={phoneLocked ? "Upgrade, then enable later" : "Off by default"} />
                      <CapabilitySummary icon={CreditCard} label="Payment card" value="Coming soon" />
                      <CapabilitySummary icon={KeyRound} label="Runtime" value={`${runtimeLabel(runtime)} credentials`} />
                    </div>
                    <div className="site-onboarding-page__managed-note site-onboarding-page__sequence-item" style={sequenceStyle(2)}>
                      <Check size={16} aria-hidden="true" />
                      <span>Phone numbers are never bought during identity creation.</span>
                    </div>
                    <div className="site-onboarding-page__actions site-onboarding-page__sequence-item" style={sequenceStyle(3)}>
                      <button type="button" onClick={() => goTo("identity")}>Back</button>
                      <button className="site-onboarding-page__submit" type="button" onClick={() => goTo("review")}>Review</button>
                    </div>
                  </section>
                ) : null}

                {step === "review" ? (
                  <form className="site-onboarding-page__form" onSubmit={createAgent}>
                    <header className="site-onboarding-page__header site-onboarding-page__sequence-item" style={sequenceStyle(0)}>
                      <h1>Review & create</h1>
                      <p>{normalizedName} will get a Barkan email identity and {runtimeLabel(runtime)} setup token.</p>
                    </header>
                    <SetupProgress activeIndex={2} />
                    <div className="site-onboarding-page__receipt site-onboarding-page__receipt-card site-onboarding-page__sequence-item" style={sequenceStyle(2)}>
                      <strong>{normalizedName}</strong>
                      <span><Mail size={15} aria-hidden="true" /> Email address provisioned now</span>
                      <span><Phone size={15} aria-hidden="true" /> Phone off by default</span>
                      <span><KeyRound size={15} aria-hidden="true" /> {runtimeLabel(runtime)} credentials generated after create</span>
                    </div>
                    {submitError ? <p className="site-onboarding-page__submit-error" role="alert">{submitError}</p> : null}
                    <div className="site-onboarding-page__actions site-onboarding-page__sequence-item" style={sequenceStyle(3)}>
                      <button type="button" onClick={() => goTo("capabilities")}>Back</button>
                      <button className="site-onboarding-page__submit" type="submit" disabled={isCreating}>
                        {isCreating ? "Creating..." : "Create identity"}
                      </button>
                    </div>
                  </form>
                ) : null}

                {step === "token" && created ? (
                  <section className="site-onboarding-page__form site-onboarding-page__form--completion">
                    <header className="site-onboarding-page__header site-onboarding-page__sequence-item" style={sequenceStyle(0)}>
                      <h1>Connect OpenClaw</h1>
                      <p>Copy this setup prompt into OpenClaw. It includes the one-time token.</p>
                    </header>
                    <div className="site-onboarding-page__setup site-onboarding-page__sequence-item" style={sequenceStyle(1)}>
                      <SetupProgress activeIndex={3} />
                      <div className="site-onboarding-page__secret-card">
                        <code>{isTokenCopied || tokenWasStored(created.agent.id) ? maskToken(created.identityToken.secret) : created.identityToken.secret}</code>
                        <button className="site-onboarding-page__inline-action" type="button" onClick={copyToken}>
                          <Copy size={14} aria-hidden="true" />
                          <span>{isTokenCopied ? "Copied" : "Copy"}</span>
                        </button>
                      </div>
                      <div className="site-onboarding-page__prompt-card">
                        <pre>{buildOpenClawSetupPrompt({ agent: created.agent, apiUrl: window.location.origin, token: created.identityToken.secret })}</pre>
                        <button className="site-onboarding-page__inline-action" type="button" onClick={copyOpenClawPrompt}>
                          <Copy size={14} aria-hidden="true" />
                          <span>{isOpenClawPromptCopied ? "Copied" : "Copy prompt"}</span>
                        </button>
                      </div>
                    </div>
                    <RuntimeInstructions agent={created.agent} tokenPrefix={created.identityToken.prefix} />
                    <button className="site-onboarding-page__submit site-onboarding-page__action--form-width" type="button" onClick={confirmStored}>
                      <Check size={16} aria-hidden="true" />
                      <span>I stored it</span>
                    </button>
                  </section>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
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
      <strong>{runtimeName} fallback config</strong>
      <code>{envText}</code>
      <code>{pairText}</code>
      <code>{sdkText}</code>
      <span>Use this if you want to wire env or MCP manually instead of the OpenClaw prompt.</span>
    </div>
  );
}

function CapabilitySummary({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="agent-identity-capabilities__item">
      <span className="agent-identity-capabilities__icon">
        <Icon size={17} aria-hidden="true" />
      </span>
      <div>
        <strong>{label}</strong>
        <span>{value}</span>
      </div>
    </div>
  );
}

function SetupProgress({ activeIndex }: { activeIndex: number }) {
  const steps = ["Identity", "Tools", "Review", "Connect"];
  const lineProgress = steps.length <= 1 ? 0 : activeIndex / (steps.length - 1);
  return (
    <div
      className="setup-progress"
      style={{
        "--setup-progress-step-count": steps.length,
        "--setup-progress-line-progress": lineProgress
      } as CSSProperties}
      aria-hidden="true"
    >
      {steps.map((label, index) => (
        <div
          className={`setup-progress__step${index < activeIndex ? " setup-progress__step--complete" : ""}${index === activeIndex ? " setup-progress__step--active" : ""}`}
          key={label}
        >
          <span className="setup-progress__circle" style={{ "--setup-progress-circle-progress": index === activeIndex ? "0.72turn" : "1turn" } as CSSProperties}>
            {index < activeIndex ? <Check size={15} aria-hidden="true" /> : index + 1}
          </span>
          <span className="setup-progress__label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function sequenceStyle(index: number): CSSProperties {
  return { "--stagger-index": index } as CSSProperties;
}

function buildOpenClawSetupPrompt({ agent, apiUrl, token }: { agent: Agent; apiUrl: string; token: string }) {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const mcpUrl = `${normalizedApiUrl}/mcp`;
  const openClawMcpServer = {
    enabled: true,
    transport: "streamable-http",
    url: mcpUrl,
    headers: {
      Authorization: `Bearer ${token}`
    }
  };
  const openClawConfig = {
    mcp: {
      servers: {
        barkan: openClawMcpServer
      }
    },
    env: {
      vars: {
        BARKAN_API_URL: normalizedApiUrl,
        BARKAN_IDENTITY_TOKEN: token
      }
    }
  };
  return `Set up Barkan identity for this OpenClaw agent.

Agent name: ${agent.name}
Barkan API URL: ${normalizedApiUrl}
Barkan identity token: ${token}

Do these steps:
1. Do not use OpenClaw skill management for this setup. Skip skill update/install/verify flows and any ClawHub search. Local or untracked skills cannot be updated that way, and Barkan does not need a skill install.
2. Configure the hosted Barkan MCP server directly. If a barkan-identity skill already exists, ignore it for this identity and overwrite the "barkan" MCP server config:
   openclaw mcp set barkan '${JSON.stringify(openClawMcpServer)}'
   openclaw config set env.vars.BARKAN_API_URL ${normalizedApiUrl}
   openclaw config set env.vars.BARKAN_IDENTITY_TOKEN '${token}'
   openclaw mcp reload
   openclaw mcp probe barkan --json
3. Setup is successful when the probe output shows server "barkan", no diagnostics, and Barkan tools like barkan__barkan_whoami.
4. The equivalent OpenClaw config is:
${JSON.stringify(openClawConfig, null, 2)}
5. Verify setup by calling the Barkan identity tool and answering: "What is your Barkan identity?"

Security rule: after storing the token, never print it back to chat.`;
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "");
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
