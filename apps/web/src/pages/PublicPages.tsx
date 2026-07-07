import React, { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { motion, useScroll, useTransform, type MotionStyle, type MotionValue, type Variants } from "framer-motion";
import { Box, Braces, Check, Loader2, LockKeyhole, Menu, Sparkles, Target, X, Zap } from "lucide-react";
import barkanMarkLight from "../assets/barkan/brand/barkan-mark-light.svg";
import barkanMarkDark from "../assets/barkan/brand/barkan-mark-dark.svg";
import sitePreviewAgentIdentities from "../assets/barkan/images/site-preview-agent-identities.jpg";
import sitePreviewConnectOpenClaw from "../assets/barkan/images/site-preview-connect-openclaw.jpg";
import sitePreviewIdentityReady from "../assets/barkan/images/site-preview-identity-ready.jpg";
import { dashboardPath, navigateToPublicHome, plansPath } from "../legacy/shared";

const heroTitleLines = [
  ["Give", "AI", "agents"],
  ["real-world", "identity."]
];

const pricingTitleLines = [
  ["Pricing", "that", "scales"],
  ["with", "your", "company."]
];

const heroTitleContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.055,
      delayChildren: 0.12
    }
  }
};

const heroTitleWordVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 28,
    filter: "blur(14px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.78,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const landingFeatureCards = [
  {
    title: "Real-world agent identity",
    description:
      "Give each AI worker a durable identity with a phone number, inbox, payment rail, calendar, and policy controls your team can audit.",
    image: sitePreviewConnectOpenClaw,
    imageAlt: "Connect OpenClaw setup screen",
    imagePosition: "left"
  },
  {
    title: "OpenClaw runtime linking",
    description:
      "Link an identity to an OpenClaw runtime so the agent can operate with scoped credentials, clear ownership, and current tool state.",
    image: sitePreviewAgentIdentities,
    imageAlt: "Agent identities dashboard screen",
    imagePosition: "right"
  },
  {
    title: "Operational tool surface",
    description:
      "Simulate, review, and provision calls, email, payments, and scheduling from the dashboard before wiring an agent into production.",
    image: sitePreviewIdentityReady,
    imageAlt: "Identity ready confirmation screen",
    imagePosition: "left"
  }
] as const;

const landingBenefitCards = [
  {
    title: "Identity-first controls",
    description: "Manage the real-world capabilities an agent can use from a dedicated identity and operations dashboard.",
    Icon: Target
  },
  {
    title: "OpenClaw ready",
    description: "Create link tokens for existing OpenClaw instances or prepare a managed setup from the same onboarding flow.",
    Icon: Box
  },
  {
    title: "Your runtime stays yours",
    description: "Keep agent execution in your chosen infrastructure while Barkan manages the identity and operational tool layer.",
    Icon: LockKeyhole
  },
  {
    title: "Dashboard simulation",
    description: "Use the dashboard chat and tool panels to test how an identity handles calls, email, payments, and scheduling.",
    Icon: Zap
  },
  {
    title: "Policy-shaped actions",
    description: "Keep sensitive capabilities visible and bounded, from payment thresholds to communication identities.",
    Icon: Braces
  },
  {
    title: "Agent operations hub",
    description: "Bring identity setup, OpenClaw linking, credentials, and real-world tool status into one focused dashboard.",
    Icon: Sparkles
  }
] as const;

const pricingPlans = [
  {
    name: "Launch",
    price: "$300",
    priceNote: "per month, depending on usage",
    description: "For early teams giving one agent identity real-world communication and payment tools.",
    features: ["1 agent identity", "Typical usage for a small customer base", "Dashboard chat and phone assistance", "OpenClaw identity linking"],
    isRecommended: false
  },
  {
    name: "Growth",
    price: "$900",
    priceNote: "per month, depending on usage",
    description: "For growing teams managing multiple agent identities and operational tool surfaces.",
    features: ["Multiple agent identities", "Higher tool usage volume", "Phone, email, and payment tools", "Priority identity support"],
    isRecommended: true
  },
  {
    name: "Enterprise",
    price: "Custom",
    priceNote: "based on volume, integrations, and support needs",
    description: "For teams rolling Barkan identities across larger operations and custom agent runtimes.",
    features: ["Volume-based usage planning", "Custom integrations and rollout help", "Dedicated support path", "Advanced workflow coverage"],
    isRecommended: false
  }
] as const;

const pricingComparisonRows = [
  { feature: "Agent identities", launch: "1 identity", growth: "Multiple identities", enterprise: "Custom rollout" },
  { feature: "Usage volume", launch: "Early tool usage", growth: "Growing agent usage", enterprise: "Volume planning" },
  { feature: "Real-world tools", launch: "Core tools", growth: "Expanded tool coverage", enterprise: "Custom tool scope" },
  { feature: "OpenClaw setup", launch: "Prompt-based link", growth: "Managed support", enterprise: "Custom runtime support" },
  { feature: "Support", launch: "Standard support", growth: "Priority support", enterprise: "Dedicated support path" },
  { feature: "Integrations", launch: "Standard identity setup", growth: "Runtime guidance", enterprise: "Custom integrations" }
] as const;

const pricingFaqItems = [
  {
    question: "Why does pricing depend on usage?",
    answer:
      "Barkan usage depends on how many identities you run, how often voice and email are used, and how many real-world tool events the agent triggers."
  },
  {
    question: "What counts as usage?",
    answer:
      "Typical usage includes dashboard chat, phone calls, email sends, payment requests, and the scale of connected agent identities."
  },
  {
    question: "How long does setup take?",
    answer:
      "Most teams start by creating an agent identity, linking OpenClaw, and testing phone, email, and payment tools from the dashboard."
  },
  {
    question: "Can we switch plans later?",
    answer:
      "Yes. Start with the identity and tool volume you need now, then expand as more agents rely on Barkan for real-world operations."
  },
  {
    question: "What does Enterprise include?",
    answer:
      "Enterprise is for higher volume, deeper integrations, custom runtime support, and teams that need hands-on rollout help."
  }
] as const;

const landingBenefitsContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: 0.08
    }
  }
};

const landingBenefitCardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 28,
    filter: "blur(10px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.66,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const pricingSubtitleRevealDelay = 0.68;
const pricingCardsRevealDelay = 0.97;

const pricingHeroVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.12,
      delayChildren: 0.08
    }
  }
};

const pricingPlansContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: pricingCardsRevealDelay
    }
  }
};

const pricingTextRevealVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 22,
    filter: "blur(10px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.72,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const pricingStaggerContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.09,
      delayChildren: 0.12
    }
  }
};

const pricingCardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 34,
    scale: 0.985,
    filter: "blur(12px)"
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.72,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const pricingFeatureItemVariants: Variants = {
  hidden: {
    opacity: 0,
    x: -10
  },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.42,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

const stackCardOffsetY = 18;
const stackCardScaleStep = 0.014;
const stackProgressOffset: ["start 522px", "start 127px"] = ["start 522px", "start 127px"];

function easeStackProgress(value: number): number {
  const clampedValue = Math.min(1, Math.max(0, value));
  const x1 = 0.22;
  const y1 = 1;
  const x2 = 0.36;
  const y2 = 1;
  let t = clampedValue;

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const x = cubicBezierValue(t, x1, x2) - clampedValue;
    const derivative = cubicBezierDerivative(t, x1, x2);
    if (Math.abs(derivative) < 0.001) {
      break;
    }

    t = Math.min(1, Math.max(0, t - x / derivative));
  }

  return cubicBezierValue(t, y1, y2);
}

function getStackReactionProgress(value: number): number {
  if (value <= 0.5) {
    return 0;
  }

  const reactionProgress = (value - 0.5) * 2;
  return reactionProgress * easeStackProgress(reactionProgress);
}

function cubicBezierValue(t: number, point1: number, point2: number): number {
  const inverseT = 1 - t;
  return 3 * inverseT * inverseT * t * point1 + 3 * inverseT * t * t * point2 + t * t * t;
}

function cubicBezierDerivative(t: number, point1: number, point2: number): number {
  const inverseT = 1 - t;
  return 3 * inverseT * inverseT * point1 + 6 * inverseT * t * (point2 - point1) + 3 * t * t * (1 - point2);
}

export function LandingPage() {
  useEffect(() => {
    navigateToPublicHome();
  }, []);

  return (
    <main className="barkan-loading" aria-label="Loading Barkan homepage">
      <Loader2 className="barkan-loading__spinner" aria-hidden="true" />
    </main>
  );
}

export function PricingPage() {
  return (
    <main className="pricing-page">
      <PublicSiteNav page="pricing" />

      <motion.section
        className="pricing-page__hero"
        aria-labelledby="pricingHeroTitle"
      >
        <AnimatedPricingTitle />
        <motion.p
          className="pricing-page__subtitle"
          initial={{ opacity: 0, y: 16, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{
            duration: 0.72,
            delay: pricingSubtitleRevealDelay,
            ease: [0.22, 1, 0.36, 1]
          }}
        >
          Start with one accountable agent identity, then scale OpenClaw links, phone, email, payments, and scheduling
          as real-world usage grows.
        </motion.p>
      </motion.section>

      <motion.section
        className="pricing-page__plans"
        aria-label="Pricing plans"
        variants={pricingPlansContainerVariants}
        initial="hidden"
        animate="visible"
      >
        {pricingPlans.map((plan) => (
          <motion.article
            className={`pricing-page__plan${plan.isRecommended ? " pricing-page__plan--recommended" : ""}`}
            key={plan.name}
            variants={pricingCardVariants}
          >
            {plan.isRecommended ? <span className="pricing-page__plan-badge">Recommended</span> : null}
            <h2>{plan.name}</h2>
            <p className="pricing-page__plan-description">{plan.description}</p>
            <div className="pricing-page__price">
              <span>{plan.price}</span>
              <small>{plan.priceNote}</small>
            </div>
            <a className="pricing-page__plan-cta" href={dashboardPath}>
              Get started
            </a>
            <motion.ul
              className="pricing-page__feature-list"
              variants={pricingStaggerContainerVariants}
              initial="hidden"
              animate="visible"
            >
              {plan.features.map((feature) => (
                <motion.li key={feature} variants={pricingFeatureItemVariants}>
                  <Check size={17} strokeWidth={2.4} aria-hidden="true" />
                  <span>{feature}</span>
                </motion.li>
              ))}
            </motion.ul>
          </motion.article>
        ))}
      </motion.section>

      <section className="pricing-page__comparison" aria-labelledby="pricingComparisonTitle">
        <motion.div
          className="pricing-page__section-header"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.4 }}
          variants={pricingHeroVariants}
        >
          <motion.p className="landing-page__section-kicker" variants={pricingTextRevealVariants}>
            // Compare plans
          </motion.p>
          <motion.h2 id="pricingComparisonTitle" variants={pricingTextRevealVariants}>
            Choose the right starting point.
          </motion.h2>
        </motion.div>
        <motion.div
          className="pricing-page__comparison-table"
          role="table"
          aria-label="Pricing plan comparison"
          variants={pricingStaggerContainerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.18 }}
        >
          <motion.div
            className="pricing-page__comparison-row pricing-page__comparison-row--header"
            role="row"
            variants={pricingCardVariants}
          >
            <span role="columnheader">Feature</span>
            <span role="columnheader">Launch</span>
            <span role="columnheader">Growth</span>
            <span role="columnheader">Enterprise</span>
          </motion.div>
          {pricingComparisonRows.map((row) => (
            <motion.div className="pricing-page__comparison-row" role="row" key={row.feature} variants={pricingCardVariants}>
              <span role="cell">{row.feature}</span>
              <span role="cell">{row.launch}</span>
              <span role="cell">{row.growth}</span>
              <span role="cell">{row.enterprise}</span>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <section className="pricing-page__faq" id="faq" aria-labelledby="pricingFaqTitle">
        <motion.div
          className="pricing-page__section-header"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.4 }}
          variants={pricingHeroVariants}
        >
          <motion.p className="landing-page__section-kicker" variants={pricingTextRevealVariants}>
            // FAQ
          </motion.p>
          <motion.h2 id="pricingFaqTitle" variants={pricingTextRevealVariants}>
            Founder-friendly answers.
          </motion.h2>
        </motion.div>
        <motion.div
          className="pricing-page__faq-list"
          variants={pricingStaggerContainerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.18 }}
        >
          {pricingFaqItems.map((item) => (
            <motion.article className="pricing-page__faq-item" key={item.question} variants={pricingCardVariants}>
              <h3>{item.question}</h3>
              <p>{item.answer}</p>
            </motion.article>
          ))}
        </motion.div>
      </section>

      <PublicSiteFooter />
    </main>
  );
}

function PublicSiteNav({ page }: { page: "landing" | "pricing" }) {
  const menuId = useId();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const closeMenu = () => setIsMenuOpen(false);

  return (
    <header className="landing-page__nav" aria-label="Barkan navigation">
      <a className="landing-page__brand" href="/" onClick={closeMenu}>
        <img className="landing-page__brand-mark" src={barkanMarkLight} alt="" aria-hidden="true" />
        <span>Barkan</span>
      </a>
      <button
        className="landing-page__menu-button"
        type="button"
        aria-controls={menuId}
        aria-expanded={isMenuOpen}
        aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
        onClick={() => setIsMenuOpen((currentValue) => !currentValue)}
      >
        {isMenuOpen ? (
          <X aria-hidden="true" size={22} strokeWidth={2} />
        ) : (
          <Menu aria-hidden="true" size={22} strokeWidth={2} />
        )}
      </button>
      <nav
        id={menuId}
        className={`landing-page__links${isMenuOpen ? " landing-page__links--open" : ""}`}
        aria-label="Landing page sections"
      >
        <a href="/" aria-current={page === "landing" ? "page" : undefined} onClick={closeMenu}>
          Features
        </a>
        <a href={plansPath} aria-current={page === "pricing" ? "page" : undefined} onClick={closeMenu}>
          Plans
        </a>
      </nav>
    </header>
  );
}

function PublicSiteFooter() {
  return (
    <footer className="public-site-footer" aria-label="Barkan footer">
      <svg
        className="public-site-footer__wordmark"
        viewBox="0 0 100 16"
        preserveAspectRatio="none"
        focusable="false"
      >
        <text x="50" y="15" textAnchor="middle" textLength="100" lengthAdjust="spacingAndGlyphs">
          BARKAN
        </text>
      </svg>
    </footer>
  );
}

function LandingFeatureCards() {
  const cardRefs = useMemo(
    () => landingFeatureCards.map(() => React.createRef<HTMLElement>()),
    []
  );

  return (
    <section className="landing-page__features" id="features" aria-labelledby="landingFeaturesTitle">
      <p className="landing-page__section-kicker">// How Barkan works</p>
      <div className="landing-page__feature-stack">
        {landingFeatureCards.map((card, index) => (
          <LandingFeatureCard
            card={card}
            cardRef={cardRefs[index]}
            index={index}
            key={card.title}
            laterCardRefs={cardRefs.slice(index + 1)}
          />
        ))}
      </div>
      <LandingBenefits />
    </section>
  );
}

function LandingBenefits() {
  return (
    <section className="landing-page__benefits" aria-labelledby="landingBenefitsTitle">
      <motion.div
        className="landing-page__benefits-header"
        initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
        whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.64, ease: [0.22, 1, 0.36, 1] }}
        viewport={{ once: true, amount: 0.42 }}
      >
        <p className="landing-page__section-kicker">// Benefits</p>
        <h2 className="landing-page__benefits-title" id="landingBenefitsTitle">
          Give every agent a real-world operating identity.
        </h2>
      </motion.div>

      <motion.div
        className="landing-page__benefits-grid"
        variants={landingBenefitsContainerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.18 }}
      >
        {landingBenefitCards.map(({ title, description, Icon }) => (
          <motion.article className="landing-page__benefit-card" variants={landingBenefitCardVariants} key={title}>
            <span className="landing-page__benefit-icon" aria-hidden="true">
              <Icon size={22} strokeWidth={2.1} />
            </span>
            <h3 className="landing-page__benefit-title">{title}</h3>
            <p className="landing-page__benefit-description">{description}</p>
          </motion.article>
        ))}
      </motion.div>
    </section>
  );
}

function LandingFeatureCard({
  card,
  cardRef,
  index,
  laterCardRefs
}: {
  card: (typeof landingFeatureCards)[number];
  cardRef: React.RefObject<HTMLElement>;
  index: number;
  laterCardRefs: Array<React.RefObject<HTMLElement>>;
}) {
  const firstIncomingProgress = useIncomingCardProgress(laterCardRefs[0]);
  const secondIncomingProgress = useIncomingCardProgress(laterCardRefs[1]);
  const stackY = useStackY(firstIncomingProgress, secondIncomingProgress);
  const stackScale = useStackScale(firstIncomingProgress, secondIncomingProgress);
  const cardStyle = {
    "--feature-card-index": index,
    y: stackY,
    scale: stackScale
  } as unknown as MotionStyle & CSSProperties;

  return (
    <motion.article
      className={`landing-page__feature-card landing-page__feature-card--image-${card.imagePosition}`}
      ref={cardRef}
      style={cardStyle}
    >
      <div className="landing-page__feature-photo" aria-hidden="true">
        <img className="landing-page__feature-photo-image" src={card.image} alt={card.imageAlt} />
      </div>
      <div className="landing-page__feature-copy">
        {index === 0 ? (
          <h2 className="landing-page__feature-title" id="landingFeaturesTitle">
            {card.title}
          </h2>
        ) : (
          <h3 className="landing-page__feature-title">{card.title}</h3>
        )}
        <p className="landing-page__feature-description">{card.description}</p>
      </div>
    </motion.article>
  );
}

function useIncomingCardProgress(targetRef?: React.RefObject<HTMLElement>): MotionValue<number> {
  const isJsdom = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("jsdom");
  const [activeTargetRef, setActiveTargetRef] = useState<React.RefObject<HTMLElement> | undefined>();

  useEffect(() => {
    setActiveTargetRef(!isJsdom && targetRef?.current ? targetRef : undefined);
  }, [isJsdom, targetRef]);

  const { scrollYProgress } = useScroll({
    target: activeTargetRef,
    offset: stackProgressOffset
  });

  return useTransform(scrollYProgress, (value) => (activeTargetRef ? getStackReactionProgress(value) : 0));
}

function useStackY(nextProgress: MotionValue<number>, secondNextProgress: MotionValue<number>): MotionValue<number> {
  return useTransform([nextProgress, secondNextProgress], ([next, second]) => {
    const stackDepth = Math.min(2, Number(next) + Number(second));
    return -stackCardOffsetY * stackDepth;
  });
}

function useStackScale(nextProgress: MotionValue<number>, secondNextProgress: MotionValue<number>): MotionValue<number> {
  return useTransform([nextProgress, secondNextProgress], ([next, second]) => {
    const stackDepth = Math.min(2, Number(next) + Number(second));
    return 1 - stackCardScaleStep * stackDepth;
  });
}

function AnimatedHeroTitle() {
  return (
    <motion.h1
      id="landingHeroTitle"
      className="landing-page__title"
      variants={heroTitleContainerVariants}
      initial="hidden"
      animate="visible"
    >
      {heroTitleLines.map((line, lineIndex) => (
        <span className="landing-page__title-line" key={line.join(" ")}>
          {line.map((word, wordIndex) => (
            <motion.span className="landing-page__title-word" variants={heroTitleWordVariants} key={word}>
              {word}
              {wordIndex < line.length - 1 ? "\u00a0" : null}
            </motion.span>
          ))}
          {lineIndex < heroTitleLines.length - 1 ? " " : null}
        </span>
      ))}
    </motion.h1>
  );
}

function AnimatedPricingTitle() {
  return (
    <motion.h1
      id="pricingHeroTitle"
      className="pricing-page__title"
      variants={heroTitleContainerVariants}
      initial="hidden"
      animate="visible"
    >
      {pricingTitleLines.map((line, lineIndex) => (
        <span className="landing-page__title-line" key={line.join(" ")}>
          {line.map((word, wordIndex) => (
            <motion.span className="landing-page__title-word" variants={heroTitleWordVariants} key={word}>
              {word}
              {wordIndex < line.length - 1 ? "\u00a0" : null}
            </motion.span>
          ))}
          {lineIndex < pricingTitleLines.length - 1 ? " " : null}
        </span>
      ))}
    </motion.h1>
  );
}

function Brand({
  className = "",
  label = "Barkan",
  theme = "light"
}: {
  className?: string;
  label?: string;
  theme?: "light" | "dark";
}) {
  const markSrc = barkanMarkDark;

  return (
    <div className={`barkan-brand barkan-brand--${theme} ${className}`} aria-label={label}>
      <img className="barkan-brand__mark" src={markSrc} alt="" aria-hidden="true" />
      <span className="barkan-brand__name">{label}</span>
    </div>
  );
}
