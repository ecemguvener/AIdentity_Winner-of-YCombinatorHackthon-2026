import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { api, type User } from "../api";
import { Brand, FloatingField, getErrorMessage, panelTransitionDurationMs, requiredFieldMessage, type AuthMode, type AuthStep, type AuthTransition, type PanelState } from "../shared";

export function AuthScreen({
  onAuthed,
  onReady
}: {
  onAuthed: (user: User) => void;
  onReady: () => Promise<void>;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [step, setStep] = useState<AuthStep>("email");
  const [transition, setTransition] = useState<AuthTransition | null>(null);
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get("email") ?? "");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [isEmailSubmitting, setIsEmailSubmitting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const transitionTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (step === "email") {
      emailInputRef.current?.focus();
      return;
    }

    passwordInputRef.current?.focus();
  }, [step]);

  function getAuthPanelState(panelStep: AuthStep): PanelState {
    if (transition !== null) {
      if (transition.from === panelStep) {
        return "outgoing";
      }
      if (transition.to === panelStep) {
        return "incoming";
      }
    }

    return step === panelStep ? "active" : "hidden";
  }

  function transitionToStep(nextStep: AuthStep) {
    if (transition !== null || nextStep === step) {
      return;
    }

    setTransition({ from: step, to: nextStep });
    transitionTimeoutRef.current = window.setTimeout(() => {
      setStep(nextStep);
      setTransition(null);
      transitionTimeoutRef.current = null;
    }, panelTransitionDurationMs);
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    if (isEmailSubmitting || transition !== null) {
      return;
    }

    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      setEmailError(requiredFieldMessage);
      emailInputRef.current?.focus();
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setEmailError("Please enter a valid email address");
      emailInputRef.current?.focus();
      return;
    }

    setEmail(normalizedEmail);
    setEmailError("");
    setPasswordError("");

    setIsEmailSubmitting(true);
    try {
      const response = await api.checkEmail(normalizedEmail);
      setMode(response.exists ? "login" : "signup");
      transitionToStep("password");
    } catch (lookupError) {
      setEmailError(getErrorMessage(lookupError, "Could not check this email"));
    } finally {
      setIsEmailSubmitting(false);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setPasswordError(requiredFieldMessage);
      passwordInputRef.current?.focus();
      return;
    }

    if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      passwordInputRef.current?.focus();
      return;
    }

    setPasswordError("");
    setIsSubmitting(true);

    try {
      const response =
        mode === "login" ? await api.login(email.trim(), password) : await api.signup(email.trim(), password);
      api.clearForcedLogout();
      onAuthed(response.user);
      await onReady();
    } catch (authError) {
      setPasswordError(getErrorMessage(authError, "Authentication failed"));
    } finally {
      setIsSubmitting(false);
    }
  }

  const emailPanelState = getAuthPanelState("email");
  const passwordPanelState = getAuthPanelState("password");

  return (
    <main className="auth-page" aria-label="Authentication">
      <div className="auth-page__inner">
        <Brand />

        <section className="auth-card">
          <div className="auth-card__stage">
            <div
              className={`auth-card__panel auth-card__panel--${emailPanelState}`}
              aria-hidden={emailPanelState !== "active"}
            >
              <header className="auth-card__header">
                <h1>Welcome !</h1>
              </header>

              <form className="auth-card__form" onSubmit={submitEmail} noValidate>
                <FloatingField
                  ref={emailInputRef}
                  autoComplete="email"
                  errorMessage={emailError}
                  inputMode="email"
                  label="Email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(nextEmail) => {
                    setEmail(nextEmail.trimStart());
                    setEmailError("");
                  }}
                />
                <button
                  className={isEmailSubmitting ? "auth-card__submit auth-card__submit--loading" : "auth-card__submit"}
                  type="submit"
                  disabled={isEmailSubmitting}
                  aria-busy={isEmailSubmitting}
                >
                  {isEmailSubmitting ? <span className="barkan-button-loader" aria-hidden="true" /> : <span>Continue</span>}
                </button>
              </form>
            </div>

            <div
              className={`auth-card__panel auth-card__panel--${passwordPanelState}`}
              aria-hidden={passwordPanelState !== "active"}
            >
              <header className="auth-card__header">
                <h1>{mode === "login" ? "Enter password" : "Choose password"}</h1>
                <p>
                  {mode === "login" ? (
                    <>
                      Continue as <span>{email}</span>
                    </>
                  ) : (
                    "Use at least 8 characters to secure your Barkan workspace."
                  )}
                </p>
              </header>

              <form className="auth-card__form" onSubmit={submitPassword} noValidate>
                <FloatingField
                  ref={passwordInputRef}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  errorMessage={passwordError}
                  label="Password"
                  minLength={8}
                  name="password"
                  type="password"
                  value={password}
                  onChange={(nextPassword) => {
                    setPassword(nextPassword);
                    setPasswordError("");
                  }}
                />
                <button
                  className={isSubmitting ? "auth-card__submit auth-card__submit--loading" : "auth-card__submit"}
                  type="submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                >
                  {isSubmitting ? <span className="barkan-button-loader" aria-hidden="true" /> : <span>Continue</span>}
                </button>
              </form>

              <button className="auth-card__back" type="button" onClick={() => transitionToStep("email")}>
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Use another email</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}