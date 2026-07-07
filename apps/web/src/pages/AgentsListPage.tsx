import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BookOpen, Check, Copy, FileText, Loader2, Server, X, Zap } from "lucide-react";
import { api, type SiteDetailResponse } from "../api";
import {
  Brand,
  agentIdentityCapabilities,
  buildIdentityReceipt,
  buildOpenClawLinkPrompt,
  buttonLoadingDurationMs,
  FieldError,
  FloatingField,
  getErrorMessage,
  getStaggerStyle,
  isCompletionOnboardingStep,
  isTimeoutLikeSetupError,
  onboardingPanelTransitionDurationMs,
  onboardingPanelTransitionSwapMs,
  onboardingSetupSteps,
  requiredFieldMessage,
  siteProgressSteps,
  siteStepIndexes,
  sleep,
  slugifyIdentityName,
  type OpenClawConnectionMode,
  type PanelState,
  type SetupProgressStep,
  type SetupStepProgress,
  type SiteOnboardingStep,
  type StepTransition
} from "../legacy/shared";
import { SetupProgressStepper } from "./AgentDetailPage";
import { BackChevronIcon } from "./SettingsPage";

export function SiteOnboardingScreen({
  onCancel,
  onCreated
}: {
  onCancel: () => void;
  onCreated: (detail: SiteDetailResponse) => Promise<void>;
}) {
  const [step, setStep] = useState<SiteOnboardingStep>("name");
  const [displayStep, setDisplayStep] = useState<SiteOnboardingStep>("name");
  const [displayPanelState, setDisplayPanelState] = useState<PanelState>("active");
  const [transition, setTransition] = useState<StepTransition | null>(null);
  const [submittingStep, setSubmittingStep] = useState<SiteOnboardingStep | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [openClawMode, setOpenClawMode] = useState<OpenClawConnectionMode>("existing");
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [domainError, setDomainError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null);
  const [createdSiteDetail, setCreatedSiteDetail] = useState<SiteDetailResponse | null>(null);
  const [createdApiKeySecret, setCreatedApiKeySecret] = useState<{ apiKeyId: string; secret: string } | null>(null);
  const [isApiKeyCopied, setIsApiKeyCopied] = useState(false);
  const [isPromptCopied, setIsPromptCopied] = useState(false);
  const [isPreparingSetup, setIsPreparingSetup] = useState(false);
  const [isSkippingSetup, setIsSkippingSetup] = useState(false);
  const [isWaitingForAgent, setIsWaitingForAgent] = useState(false);
  const [activeSetupStep, setActiveSetupStep] = useState<SetupProgressStep | null>(null);
  const [completedSetupSteps, setCompletedSetupSteps] = useState<Set<SetupProgressStep>>(() => new Set());
  const [setupStepProgress, setSetupStepProgress] = useState<SetupStepProgress>({});
  const [isReceiptCopied, setIsReceiptCopied] = useState(false);
  const currentStepRef = useRef<SiteOnboardingStep>("name");
  const displayStepRef = useRef<SiteOnboardingStep>("name");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const domainInputRef = useRef<HTMLInputElement>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const installHeadingRef = useRef<HTMLHeadingElement>(null);
  const finishHeadingRef = useRef<HTMLHeadingElement>(null);
  const submitTimeoutRef = useRef<number | null>(null);
  const transitionSwapTimeoutRef = useRef<number | null>(null);
  const transitionFinishTimeoutRef = useRef<number | null>(null);
  const apiKeyCopiedTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (submitTimeoutRef.current !== null) {
        window.clearTimeout(submitTimeoutRef.current);
      }
      if (transitionSwapTimeoutRef.current !== null) {
        window.clearTimeout(transitionSwapTimeoutRef.current);
      }
      if (transitionFinishTimeoutRef.current !== null) {
        window.clearTimeout(transitionFinishTimeoutRef.current);
      }
      if (apiKeyCopiedTimeoutRef.current !== null) {
        window.clearTimeout(apiKeyCopiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    currentStepRef.current = step;
  }, [step]);

  useEffect(() => {
    displayStepRef.current = displayStep;
  }, [displayStep]);

  useEffect(() => {
    if (displayStep === "name") {
      nameInputRef.current?.focus();
      return;
    }
    if (displayStep === "openclaw") {
      domainInputRef.current?.focus();
      return;
    }
    if (displayStep === "setup") {
      setupHeadingRef.current?.focus();
      return;
    }
    if (displayStep === "install") {
      installHeadingRef.current?.focus();
      return;
    }
    finishHeadingRef.current?.focus();
  }, [displayStep]);

  function transitionToStep(nextStep: SiteOnboardingStep) {
    const currentStep = transition?.to ?? currentStepRef.current;
    if (nextStep === currentStep) {
      return;
    }

    if (transitionSwapTimeoutRef.current !== null) {
      window.clearTimeout(transitionSwapTimeoutRef.current);
    }
    if (transitionFinishTimeoutRef.current !== null) {
      window.clearTimeout(transitionFinishTimeoutRef.current);
    }

    currentStepRef.current = nextStep;
    setStep(nextStep);
    setTransition({ from: displayStepRef.current, to: nextStep });
    setDisplayPanelState("outgoing");
    transitionSwapTimeoutRef.current = window.setTimeout(() => {
      displayStepRef.current = nextStep;
      setDisplayStep(nextStep);
      setDisplayPanelState("incoming");
      transitionSwapTimeoutRef.current = null;
      transitionFinishTimeoutRef.current = window.setTimeout(() => {
        setDisplayPanelState("active");
        setTransition(null);
        transitionFinishTimeoutRef.current = null;
      }, onboardingPanelTransitionDurationMs - onboardingPanelTransitionSwapMs);
    }, onboardingPanelTransitionSwapMs);
  }

  function runStep(event: FormEvent, currentStep: SiteOnboardingStep, nextStep: SiteOnboardingStep) {
    event.preventDefault();
    if (submittingStep !== null || transition !== null) {
      return;
    }

    if (currentStep === "name" && !name.trim()) {
      setNameError(requiredFieldMessage);
      nameInputRef.current?.focus();
      return;
    }

    if (submitTimeoutRef.current !== null) {
      window.clearTimeout(submitTimeoutRef.current);
    }

    setSubmittingStep(currentStep);
    submitTimeoutRef.current = window.setTimeout(() => {
      setSubmittingStep(null);
      transitionToStep(nextStep);
      submitTimeoutRef.current = null;
    }, buttonLoadingDurationMs);
  }

  async function startSetup(event: FormEvent) {
    event.preventDefault();
    if (submittingStep !== null || isPreparingSetup) {
      return;
    }

    if (openClawMode === "existing" && !domain.trim()) {
      setDomainError(requiredFieldMessage);
      domainInputRef.current?.focus();
      return;
    }

    const normalizedEndpoint = openClawMode === "existing"
      ? domain.trim()
      : `${slugifyIdentityName(name)}.managed-openclaw.barkan.dev`;

    setDomain(normalizedEndpoint);
    setSubmittingStep("openclaw");
    setIsPreparingSetup(true);
    setError("");
    setDomainError("");
    setSetupError("");
    let preparedProjectId = setupProjectId;
    try {
      const setupResponse = preparedProjectId ? null : await api.createSiteSetup(name.trim(), normalizedEndpoint);
      preparedProjectId = preparedProjectId ?? setupResponse?.setup.projectId ?? null;
      if (!isMountedRef.current) {
        return;
      }

      if (setupResponse) {
        setSetupProjectId(setupResponse.setup.projectId);
        setCreatedApiKeySecret({
          apiKeyId: setupResponse.apiKey.id,
          secret: setupResponse.secret
        });
        setIsApiKeyCopied(false);
      }

      if (!preparedProjectId) {
        throw new Error("Could not create setup project.");
      }

      setSubmittingStep(null);
      setIsPreparingSetup(false);
      transitionToStep("setup");
      if (openClawMode === "deploy") {
        void completeManagedOpenClawSetup(preparedProjectId);
      } else {
        showOpenClawWaitingState();
      }
    } catch (setupStartError) {
      if (preparedProjectId) {
        setSetupProjectId(preparedProjectId);
        setSetupError(getErrorMessage(setupStartError, "Could not prepare this OpenClaw link"));
        transitionToStep("setup");
      } else {
        setError(getErrorMessage(setupStartError, "Could not create agent identity"));
      }
    } finally {
      setSubmittingStep(null);
      setIsPreparingSetup(false);
    }
  }

  function showOpenClawWaitingState() {
    setIsWaitingForAgent(true);
    setActiveSetupStep("connection");
    setCompletedSetupSteps(new Set());
    setSetupStepProgress({
      connection: { current: 0, total: 1, label: "Waiting for OpenClaw skill confirmation" }
    });
  }

  async function completeManagedOpenClawSetup(projectId: string) {
    setIsWaitingForAgent(true);
    setActiveSetupStep("connection");
    setCompletedSetupSteps(new Set());
    setSetupStepProgress({
      connection: { current: 0, total: 1, label: "Deploying managed OpenClaw instance" }
    });

    try {
      await sleep(1400);
      if (!isMountedRef.current) {
        return;
      }
      setSetupStepProgress({
        connection: { current: 1, total: 1, label: "Managed OpenClaw deployed" }
      });
      setCompletedSetupSteps(new Set(["connection"]));
      await completeIdentitySetup(projectId);
    } catch (deployError) {
      setSetupError(getErrorMessage(deployError, "Could not deploy managed OpenClaw"));
      setIsWaitingForAgent(false);
    }
  }

  async function completeIdentitySetup(projectId: string) {
    setIsSkippingSetup(true);
    setSetupError("");

    try {
      const finalDetail = await api.completeSiteSetup(projectId);
      if (!isMountedRef.current) {
        return;
      }

      setCreatedSiteDetail(finalDetail);
      setIsWaitingForAgent(false);
      setIsSkippingSetup(false);
      setActiveSetupStep(null);
      transitionToStep("install");
    } catch (completeError) {
      setSetupError(getErrorMessage(completeError, "Could not finish agent identity setup"));
      setIsWaitingForAgent(false);
      setIsSkippingSetup(false);
    }
  }

  async function retryOpenClawSetup() {
    if (!setupProjectId || isWaitingForAgent) {
      return;
    }

    setSetupError("");
    if (openClawMode === "deploy") {
      await completeManagedOpenClawSetup(setupProjectId);
      return;
    }

    showOpenClawWaitingState();
  }

  async function completeExistingOpenClawSetup() {
    if (!setupProjectId || isSkippingSetup) {
      return;
    }

    await completeIdentitySetup(setupProjectId);
  }

  async function copyConnectCommand() {
    if (!createdApiKeySecret) {
      return;
    }

    await navigator.clipboard.writeText(createdApiKeySecret.secret);
    setIsApiKeyCopied(true);
    if (apiKeyCopiedTimeoutRef.current !== null) {
      window.clearTimeout(apiKeyCopiedTimeoutRef.current);
    }
    apiKeyCopiedTimeoutRef.current = window.setTimeout(() => {
      setIsApiKeyCopied(false);
      apiKeyCopiedTimeoutRef.current = null;
    }, 1400);
  }

  async function copyOpenClawPrompt() {
    await navigator.clipboard.writeText(buildOpenClawLinkPrompt(name, createdApiKeySecret?.secret, setupProjectId));
    setIsPromptCopied(true);
    window.setTimeout(() => setIsPromptCopied(false), 1400);
  }

  async function copyOnboardingReceipt() {
    if (!createdSiteDetail) {
      return;
    }

    await navigator.clipboard.writeText(buildIdentityReceipt(createdSiteDetail.site));
    setIsReceiptCopied(true);
    window.setTimeout(() => setIsReceiptCopied(false), 1400);
  }

  async function finishOnboarding() {
    if (!createdSiteDetail) {
      return;
    }

    await onCreated(createdSiteDetail);
  }

  const currentProgressIndex = siteStepIndexes[step];
  const isCompletionDisplayStep = isCompletionOnboardingStep(displayStep);
  const completionBackdropState = displayStep === "finish" ? "active" : "hidden";
  const flowLayoutClass = isCompletionDisplayStep
    ? "site-onboarding-page__flow site-onboarding-page__flow--completion"
    : "site-onboarding-page__flow site-onboarding-page__flow--compact";
  const setupRetryLabel = setupError && isTimeoutLikeSetupError(setupError)
    ? "Timed out - retry OpenClaw link"
    : "Retry OpenClaw link";
  const shouldShowSetupErrorText = Boolean(setupError) && !isTimeoutLikeSetupError(setupError);
  const visibleConnectCommand = createdApiKeySecret ? "link token: ck_••••••••" : "Creating link token...";
  const openClawPrompt = buildOpenClawLinkPrompt(name, createdApiKeySecret?.secret, setupProjectId);
  const setupTitle = openClawMode === "deploy" ? "Deploying OpenClaw" : "Link existing OpenClaw";
  const setupDescription = openClawMode === "deploy"
    ? "We are deploying a managed OpenClaw instance and installing the Barkan identity layer."
    : "Send this prompt to your OpenClaw instance. It installs the Barkan identity skill and confirms the link with a token.";
  const readyReceipt = buildIdentityReceipt(createdSiteDetail?.site ?? null);

  return (
    <main className="site-onboarding-page" aria-label="Create agent identity">
      <div className="site-onboarding-page__canvas">
        <div className="site-onboarding-page__dark-plane" aria-hidden="true" />
        <section className="site-onboarding-page__board">
          <div className={`site-onboarding-page__completion-backdrop site-onboarding-page__completion-backdrop--${completionBackdropState}`} />

          <Brand className="site-onboarding-page__brand" />

          <div className="site-onboarding-page__progress" aria-label="Create agent identity progress">
            {siteProgressSteps.map((progressStep) => (
              <span
                key={progressStep}
                className={
                  progressStep <= currentProgressIndex
                    ? "site-onboarding-page__progress-step site-onboarding-page__progress-step--active"
                    : "site-onboarding-page__progress-step"
                }
              />
            ))}
          </div>

          <button className="site-onboarding-page__close" type="button" onClick={onCancel} aria-label="Close">
            <X size={17} aria-hidden="true" />
          </button>

          <section className={flowLayoutClass}>
            <div className="site-onboarding-page__stage">
              <OnboardingPanel state={displayPanelState}>
                {displayStep === "name" ? (
                  <>
                    <OnboardingHeader
                      title="Create an agent identity"
                      description="Give this real-world identity a name you will recognize in your dashboard."
                    />
                    <form className="site-onboarding-page__form" onSubmit={(event) => runStep(event, "name", "openclaw")} noValidate>
                      <div className="site-onboarding-page__sequence-item" style={getStaggerStyle(2)}>
                        <FloatingField
                          ref={nameInputRef}
                          autoComplete="off"
                          errorMessage={nameError}
                          label="Identity name"
                          name="identityName"
                          value={name}
                          onChange={(nextName) => {
                            setName(nextName);
                            setNameError("");
                          }}
                        />
                      </div>
                      <OnboardingSubmitAction isLoading={submittingStep === "name"} />
                    </form>
                  </>
                ) : null}

                {displayStep === "openclaw" ? (
                  <>
                    <OnboardingHeader
                      title="Connect OpenClaw"
                      description="Use an existing OpenClaw instance, or let Barkan deploy one with the identity layer already installed."
                    />
                    <form className="site-onboarding-page__form" onSubmit={startSetup} noValidate>
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__mode-grid" style={getStaggerStyle(2)}>
                        <button
                          className={`site-onboarding-page__mode-card${openClawMode === "existing" ? " site-onboarding-page__mode-card--active" : ""}`}
                          type="button"
                          aria-pressed={openClawMode === "existing"}
                          onClick={() => setOpenClawMode("existing")}
                        >
                          <Server size={18} aria-hidden="true" />
                          <strong>Existing instance</strong>
                          <span>Paste a prompt into OpenClaw and wait for the skill to confirm linking.</span>
                        </button>
                        <button
                          className={`site-onboarding-page__mode-card${openClawMode === "deploy" ? " site-onboarding-page__mode-card--active" : ""}`}
                          type="button"
                          aria-pressed={openClawMode === "deploy"}
                          onClick={() => {
                            setOpenClawMode("deploy");
                            setDomainError("");
                          }}
                        >
                          <Zap size={18} aria-hidden="true" />
                          <strong>Deploy for me</strong>
                          <span>Provision a managed OpenClaw instance with the identity layer preinstalled.</span>
                        </button>
                      </div>
                      <div className="site-onboarding-page__sequence-item" style={getStaggerStyle(2)}>
                        {openClawMode === "existing" ? (
                          <FloatingField
                            ref={domainInputRef}
                            autoComplete="url"
                            errorMessage={domainError}
                            label="OpenClaw endpoint"
                            name="openClawEndpoint"
                            placeholder="https://openclaw.example.com"
                            value={domain}
                            onChange={(nextDomain) => {
                              setDomain(nextDomain);
                              setDomainError("");
                            }}
                          />
                        ) : (
                          <div className="site-onboarding-page__managed-note">
                            <Server size={16} aria-hidden="true" />
                            <span>{`${slugifyIdentityName(name)}.managed-openclaw.barkan.dev`}</span>
                          </div>
                        )}
                      </div>
                      {error ? <p className="site-onboarding-page__submit-error">{error}</p> : null}
                      <OnboardingSubmitAction
                        isLoading={submittingStep === "openclaw" || isPreparingSetup}
                        label={openClawMode === "deploy" ? "Deploy identity" : "Create link prompt"}
                      />
                    </form>
                  </>
                ) : null}

                {displayStep === "setup" ? (
                  <>
                    <OnboardingHeader
                      headingRef={setupHeadingRef}
                      isProgrammaticallyFocusable
                      title={setupTitle}
                      description={setupDescription}
                    />
                    <div className="site-onboarding-page__setup">
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__secret-card" style={getStaggerStyle(2)}>
                        <code>{visibleConnectCommand}</code>
                        <button
                          className="site-onboarding-page__inline-action"
                          type="button"
                          onClick={() => void copyConnectCommand()}
                          disabled={!createdApiKeySecret}
                        >
                          {isApiKeyCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                          <span>{isApiKeyCopied ? "Copied" : "Copy token"}</span>
                        </button>
                      </div>

                      {openClawMode === "existing" ? (
                        <div className="site-onboarding-page__sequence-item site-onboarding-page__prompt-card" style={getStaggerStyle(3)}>
                          <pre>{openClawPrompt}</pre>
                          <button
                            className="site-onboarding-page__inline-action"
                            type="button"
                            onClick={() => void copyOpenClawPrompt()}
                          >
                            {isPromptCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                            <span>{isPromptCopied ? "Copied" : "Copy prompt"}</span>
                          </button>
                        </div>
                      ) : null}

                      <div className="site-onboarding-page__sequence-item" style={getStaggerStyle(openClawMode === "existing" ? 4 : 3)}>
                        <SetupProgressStepper
                          activeStep={activeSetupStep}
                          completedSteps={completedSetupSteps}
                          stepProgress={setupStepProgress}
                          steps={onboardingSetupSteps}
                        />
                      </div>

                      {shouldShowSetupErrorText ? (
                        <p className="site-onboarding-page__sequence-item site-onboarding-page__submit-error" style={getStaggerStyle(4)}>
                          {setupError}
                        </p>
                      ) : null}
                      {setupError ? (
                        <button
                          className="site-onboarding-page__sequence-item site-onboarding-page__inline-action site-onboarding-page__inline-action--wide"
                          style={getStaggerStyle(5)}
                          type="button"
                          onClick={() => void retryOpenClawSetup()}
                        >
                          <FileText size={16} aria-hidden="true" />
                          <span>{setupRetryLabel}</span>
                        </button>
                      ) : null}
                      <div
                        className="site-onboarding-page__sequence-item site-onboarding-page__action site-onboarding-page__action--form-width"
                        style={getStaggerStyle(setupError ? 6 : 4)}
                      >
                        <button
                          className={
                            isSkippingSetup
                              ? "site-onboarding-page__submit site-onboarding-page__submit--secondary site-onboarding-page__submit--loading"
                              : "site-onboarding-page__submit site-onboarding-page__submit--secondary"
                          }
                          type="button"
                          onClick={() => void completeExistingOpenClawSetup()}
                          disabled={!setupProjectId || isSkippingSetup}
                          aria-busy={isSkippingSetup}
                        >
                          {isSkippingSetup ? (
                            <span className="barkan-button-loader" aria-hidden="true" />
                          ) : (
                            <span>{openClawMode === "existing" ? "Demo: mark linked" : "Continue"}</span>
                          )}
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                {displayStep === "install" ? (
                  <>
                    <OnboardingHeader
                      headingRef={installHeadingRef}
                      isProgrammaticallyFocusable
                      title="Identity ready"
                      description="This agent identity now has a phone number, inbox, payment card, calendar, and OpenClaw link."
                    />
                    <div className="site-onboarding-page__ready">
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__secret-card site-onboarding-page__receipt-card" style={getStaggerStyle(2)}>
                        <code>{createdSiteDetail ? readyReceipt : "Provisioning identity..."}</code>
                        <button
                          className="site-onboarding-page__inline-action"
                          type="button"
                          onClick={() => void copyOnboardingReceipt()}
                          disabled={!createdSiteDetail}
                        >
                          {isReceiptCopied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                          <span>{isReceiptCopied ? "Copied" : "Copy receipt"}</span>
                        </button>
                      </div>
                      <div className="site-onboarding-page__sequence-item agent-identity-capabilities agent-identity-capabilities--onboarding" style={getStaggerStyle(3)}>
                        {agentIdentityCapabilities.map(({ label, value, Icon }) => (
                          <article className="agent-identity-capabilities__item" key={label}>
                            <span className="agent-identity-capabilities__icon" aria-hidden="true">
                              <Icon size={16} strokeWidth={2.2} />
                            </span>
                            <div>
                              <strong>{label}</strong>
                              <span>{value}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                      <div className="site-onboarding-page__sequence-item site-onboarding-page__action" style={getStaggerStyle(3)}>
                        <button
                          className="site-onboarding-page__submit"
                          type="button"
                          onClick={() => transitionToStep("finish")}
                          disabled={!createdSiteDetail}
                        >
                          <span>Continue</span>
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                {displayStep === "finish" ? (
                  <>
                    <OnboardingHeader
                      headingRef={finishHeadingRef}
                      isProgrammaticallyFocusable
                      title="You're all set"
                      description="Return to the dashboard to manage this agent identity and its real-world tools."
                    />
                    <div className="site-onboarding-page__finish">
                      <button
                        className="site-onboarding-page__submit"
                        type="button"
                        onClick={() => void finishOnboarding()}
                        disabled={!createdSiteDetail}
                      >
                        <span>Back to dashboard</span>
                      </button>
                    </div>
                  </>
                ) : null}
              </OnboardingPanel>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function OnboardingPanel({ state, children }: { state: PanelState; children: ReactNode }) {
  return (
    <section className={`site-onboarding-page__panel site-onboarding-page__panel--${state}`} aria-hidden={state !== "active"}>
      {children}
    </section>
  );
}

function OnboardingHeader({
  title,
  description,
  headingRef,
  isProgrammaticallyFocusable = false
}: {
  title: ReactNode;
  description: ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  isProgrammaticallyFocusable?: boolean;
}) {
  return (
    <header className="site-onboarding-page__header">
      <h1
        ref={headingRef}
        className="site-onboarding-page__sequence-item"
        tabIndex={isProgrammaticallyFocusable ? -1 : undefined}
        style={getStaggerStyle(0)}
      >
        {title}
      </h1>
      <p className="site-onboarding-page__sequence-item" style={getStaggerStyle(1)}>
        {description}
      </p>
    </header>
  );
}

function OnboardingSubmitAction({ isLoading = false, label = "Continue" }: { isLoading?: boolean; label?: string }) {
  return (
    <div className="site-onboarding-page__sequence-item site-onboarding-page__action" style={getStaggerStyle(3)}>
      <button
        className={
          isLoading
            ? "site-onboarding-page__submit site-onboarding-page__submit--loading"
            : "site-onboarding-page__submit"
        }
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading}
      >
        {isLoading ? <span className="barkan-button-loader" aria-hidden="true" /> : <span>{label}</span>}
      </button>
    </div>
  );
}
