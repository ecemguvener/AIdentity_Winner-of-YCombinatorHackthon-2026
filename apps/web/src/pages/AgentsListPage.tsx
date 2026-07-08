import { Bot, Check, Copy, Mail, Phone, Server, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { billingApi } from "../api/billing";
import { agentsApi } from "../api/agents";
import { ApiClientError } from "../api/client";
import type { Agent, CreateAgentResponse } from "../api/types";
import { Brand, getErrorMessage, requiredFieldMessage, type ToastNotificationInput } from "../shared";

type WizardStep = "identity" | "token";
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
  const [isOpenClawPromptCopied, setIsOpenClawPromptCopied] = useState(false);
  const normalizedName = name.trim();
  const normalizedDescription = description.trim();

  useEffect(() => {
    let cancelled = false;
    void billingApi.getAccount()
      .then((account) => {
        if (cancelled) return;
        const locked = account.plan === "free";
        setPhoneLocked(locked);
        setPhoneEnabled(!locked);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
        capabilities: { email: emailEnabled, phone: phoneEnabled },
        approvalMode: "always" as const
      };
      let response: CreateAgentResponse;
      try {
        response = await agentsApi.create(input);
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== "plan_limit" || !phoneEnabled) {
          throw error;
        }
        response = await agentsApi.create({
          ...input,
          capabilities: { email: emailEnabled, phone: false }
        });
        setPhoneEnabled(false);
        onNotify({ title: "Email identity created. Phone can be added after upgrade.", kind: "info" });
      }
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
      <button className="site-onboarding-page__close" type="button" aria-label="Close" onClick={onCancel}>
        <X size={18} aria-hidden="true" />
      </button>
      <div className="site-onboarding-page__panel site-onboarding-page__panel--active">
        <Brand />

        {step === "identity" ? (
          <form className="site-onboarding-page__form" onSubmit={createAgent}>
            <header className="site-onboarding-page__header">
              <h1>Create agent identity</h1>
              <p>Barkan provisions the contact points and runtime credentials automatically.</p>
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
            <div className="site-onboarding-page__receipt">
              <strong>Automatic setup</strong>
              <span><Mail size={15} aria-hidden="true" /> Email address provisioned now</span>
              <span><Phone size={15} aria-hidden="true" /> {phoneLocked ? "Phone ready after plan upgrade" : "Phone number provisioned now"}</span>
              <span>{runtimeLabel(runtime)} credentials generated after create</span>
            </div>
            {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
            <button className="site-onboarding-page__submit" type="submit" disabled={isCreating}>
              {isCreating ? "Creating..." : "Create identity"}
            </button>
          </form>
        ) : null}

        {step === "token" && created ? (
          <section className="site-onboarding-page__form">
            <header className="site-onboarding-page__header">
              <h1>Connect OpenClaw</h1>
              <p>Copy this setup prompt into OpenClaw. It includes the one-time token.</p>
            </header>
            <div className="site-onboarding-page__prompt-card">
              <div>
                <strong>OpenClaw setup prompt</strong>
                <span>Paste into OpenClaw so it installs the skill, stores the env values, and verifies the identity.</span>
              </div>
              <button type="button" onClick={copyOpenClawPrompt}>
                <Copy size={16} aria-hidden="true" />
                <span>{isOpenClawPromptCopied ? "Copied" : "Copy prompt"}</span>
              </button>
            </div>
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

function buildOpenClawSetupPrompt({ agent, apiUrl, token }: { agent: Agent; apiUrl: string; token: string }) {
  const normalizedApiUrl = apiUrl.replace(/\/$/, "");
  return `Set up Barkan identity for this OpenClaw agent.

Agent name: ${agent.name}
Barkan API URL: ${normalizedApiUrl}
Barkan identity token: ${token}

Do these steps:
1. Install or enable the OpenClaw skill named barkan-identity.
2. Store these environment variables in this agent runtime:
   BARKAN_API_URL=${normalizedApiUrl}
   BARKAN_IDENTITY_TOKEN=${token}
3. If MCP is available, configure this MCP server:
${JSON.stringify({
  mcpServers: {
    barkan: {
      transport: "http",
      url: `${normalizedApiUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  }
}, null, 2)}
4. Verify setup by calling the Barkan identity tool and answering: "What is your Barkan identity?"

Security rule: after storing the token, never print it back to chat.`;
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
