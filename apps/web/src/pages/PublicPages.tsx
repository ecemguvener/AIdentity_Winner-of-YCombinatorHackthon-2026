import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { Bot, Check, ClipboardCheck, CreditCard, FileText, Mail, Phone, Terminal, WalletCards } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import barkanMarkLight from "../assets/barkan/brand/barkan-mark-light.svg";
import sitePreviewAgentIdentities from "../assets/barkan/images/site-preview-agent-identities.jpg";
import sitePreviewIdentityReady from "../assets/barkan/images/site-preview-identity-ready.jpg";
import { requestJson } from "../api/client";
import { dashboardPath, docsSitePath, plansPath, signinPath } from "../shared";
import { docsManifest, findDocsPage } from "../docs/manifest";

const demoSteps = [
  { label: "Agent asks", value: "Book a call and email the recap", Icon: Bot },
  { label: "Owner approves", value: "Policy matched: approval required", Icon: ClipboardCheck },
  { label: "Tool runs", value: "Phone call queued, email sent", Icon: Phone },
  { label: "Audit line", value: "agent.email.send allowed", Icon: FileText }
] as const;

const howItWorks = [
  ["Create agent", "Name the identity, choose a runtime, and issue the first scoped token."],
  ["Connect runtime", "Use OpenClaw, Hermes, MCP, REST, or the Node SDK without moving your agent brain."],
  ["Set policies", "Require approvals for sensitive phone, SMS, and email actions, then inspect the audit trail."]
] as const;

const capabilitySections = [
  {
    title: "Phone numbers for agents",
    body: "Provision a Twilio-backed number, place calls through ElevenLabs, receive SMS, and keep transcripts under retention controls.",
    image: sitePreviewIdentityReady,
    Icon: Phone,
    code: `await barkan.phone.call({
  to: "+14155550198",
  task: "Confirm tomorrow's delivery window"
});`,
    comingSoon: false
  },
  {
    title: "Email addresses and inboxes",
    body: "Give each agent an address, threaded inbox, outbound sending, attachments, policy gates, and owner approval flows.",
    image: sitePreviewAgentIdentities,
    Icon: Mail,
    code: `await barkan.email.send({
  to: "casey@example.com",
  subject: "Launch check",
  text: "Can you confirm the rollout time?"
});`,
    comingSoon: false
  },
  {
    title: "Policy-controlled spending",
    body: "Coming soon: agent payment cards with spending policies, approvals, merchant context, and audit trails. Join the waitlist for early access.",
    image: null,
    Icon: CreditCard,
    code: null,
    comingSoon: true
  }
] as const;

const plans = [
  { name: "Free", price: "0 EUR", features: ["1 agent identity", "50 included emails", "Email capability", "Phone and cards unavailable"] },
  { name: "Pro", price: "29 EUR/mo", features: ["3 agent identities", "500 emails", "120 call minutes", "200 SMS", "1 active number"] },
  { name: "Scale", price: "99 EUR/mo", features: ["10 agent identities", "Higher included usage", "3 active numbers", "Priority setup help"] }
] as const;

export function LandingPage() {
  return (
    <main className="public-page">
      <Seo title="Barkan - real identity for AI agents" description="Give AI agents a phone number, email address, approvals, policies, and an audit trail." />
      <PublicSiteNav />
      <section className="public-hero" aria-labelledby="landingHeroTitle">
        <div className="public-hero__copy">
          <p className="public-kicker">Agent identity layer</p>
          <h1 id="landingHeroTitle">Give your AI agent a real identity</h1>
          <p>
            Barkan gives agents a phone number and email address, then wraps real-world actions in policies,
            owner approvals, and audit logs.
          </p>
          <div className="public-hero__actions">
            <a className="public-button public-button--primary" href={signinPath}>Start free</a>
            <a className="public-button" href={docsSitePath}>Read the docs</a>
          </div>
        </div>
        <LiveDemoStrip />
      </section>
      <HowItWorks />
      <CapabilityShowcase />
      <IntegrationsRow />
      <PricingPreview />
      <Faq />
      <PublicSiteFooter />
    </main>
  );
}

export function PricingPage() {
  return (
    <main className="public-page">
      <Seo title="Barkan pricing" description="Free, Pro, and Scale plans for real-world AI agent identities." />
      <PublicSiteNav />
      <section className="public-section public-section--tight" aria-labelledby="pricingTitle">
        <p className="public-kicker">Pricing</p>
        <h1 id="pricingTitle">Start with email. Add phone when the agent is ready.</h1>
        <p className="public-section__lead">Plans map to the shipped catalog: agent identities, email, phone numbers, call minutes, SMS, and usage metering.</p>
      </section>
      <PricingPreview expanded />
      <Faq />
      <PublicSiteFooter />
    </main>
  );
}

export function DocsSitePage({ path }: { path: string }) {
  const page = findDocsPage(path);
  const grouped = docsManifest.reduce<Record<string, typeof docsManifest>>((groups, item) => {
    groups[item.section] = [...(groups[item.section] ?? []), item];
    return groups;
  }, {});

  return (
    <main className="docs-site">
      <Seo title={`${page.title} - Barkan docs`} description="Barkan product and integration documentation." />
      <PublicSiteNav />
      <div className="docs-site__layout">
        <aside className="docs-site__sidebar" aria-label="Documentation navigation">
          {Object.entries(grouped).map(([section, pages]) => (
            <nav key={section} aria-label={section}>
              <h2>{section}</h2>
              {pages.map((item) => (
                <a key={item.slug} href={`/docs-site/${item.slug}`} aria-current={item.slug === page.slug ? "page" : undefined}>
                  {item.title}
                </a>
              ))}
            </nav>
          ))}
          <a className="docs-site__api-link" href="/docs">API reference</a>
        </aside>
        <article className="docs-site__article">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => <a href={normalizeDocsHref(href)}>{children}</a>,
              pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
            }}
          >
            {page.markdown}
          </ReactMarkdown>
        </article>
      </div>
    </main>
  );
}

function PublicSiteNav() {
  return (
    <header className="public-nav">
      <a className="public-nav__brand" href="/">
        <img src={barkanMarkLight} alt="" aria-hidden="true" />
        <span>Barkan</span>
      </a>
      <nav aria-label="Public navigation">
        <a href="/#capabilities">Capabilities</a>
        <a href={docsSitePath}>Docs</a>
        <a href={plansPath}>Pricing</a>
        <a href={dashboardPath}>Dashboard</a>
      </nav>
    </header>
  );
}

function LiveDemoStrip() {
  return (
    <motion.div className="live-demo" initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.18 } } }}>
      {demoSteps.map(({ label, value, Icon }) => (
        <motion.div className="live-demo__step" key={label} variants={{ hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }}>
          <Icon size={18} aria-hidden="true" />
          <span>{label}</span>
          <strong>{value}</strong>
        </motion.div>
      ))}
    </motion.div>
  );
}

function HowItWorks() {
  return (
    <section className="public-section" aria-labelledby="howTitle">
      <p className="public-kicker">How it works</p>
      <h2 id="howTitle">Three steps from identity to real-world action.</h2>
      <div className="public-grid public-grid--three">
        {howItWorks.map(([title, body], index) => (
          <article className="public-card" key={title}>
            <span className="public-card__index">{index + 1}</span>
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function CapabilityShowcase() {
  return (
    <section className="public-section" id="capabilities" aria-labelledby="capabilityTitle">
      <p className="public-kicker">Capabilities</p>
      <h2 id="capabilityTitle">Live primitives, clear controls.</h2>
      <div className="capability-stack">
        {capabilitySections.map((section) => (
          <article className="capability-panel" key={section.title}>
            <div className="capability-panel__copy">
              <section.Icon size={24} aria-hidden="true" />
              {section.comingSoon ? <span className="public-badge">Coming soon</span> : null}
              <h3>{section.title}</h3>
              <p>{section.body}</p>
              {section.comingSoon ? <CardWaitlist /> : <CodeSnippet code={section.code!} />}
            </div>
            {section.image ? <img src={section.image} alt="" /> : <div className="capability-panel__placeholder"><WalletCards size={44} aria-hidden="true" /></div>}
          </article>
        ))}
      </div>
    </section>
  );
}

function IntegrationsRow() {
  return (
    <section className="public-section public-section--tight" aria-labelledby="integrationsTitle">
      <p className="public-kicker">Integrations</p>
      <h2 id="integrationsTitle">Connect through the surface your agent already uses.</h2>
      <div className="integration-row">
        {[
          ["OpenClaw", "/docs-site/integrations/openclaw"],
          ["Hermes", "/docs-site/integrations/hermes"],
          ["MCP", "/docs-site/integrations/mcp"],
          ["REST / SDK", "/docs"]
        ].map(([name, href]) => (
          <a href={href} key={name}><Terminal size={18} aria-hidden="true" />{name}</a>
        ))}
      </div>
    </section>
  );
}

function PricingPreview({ expanded = false }: { expanded?: boolean }) {
  return (
    <section className="public-section" aria-labelledby="plansTitle">
      <p className="public-kicker">Pricing</p>
      <h2 id="plansTitle">Plans for the shipped identity layer.</h2>
      <div className="public-grid public-grid--three">
        {plans.map((plan) => (
          <article className="public-card public-card--price" key={plan.name}>
            <h3>{plan.name}</h3>
            <strong>{plan.price}</strong>
            <ul>
              {plan.features.map((feature) => <li key={feature}><Check size={15} aria-hidden="true" />{feature}</li>)}
              <li><CreditCard size={15} aria-hidden="true" />Payment cards: coming soon</li>
            </ul>
          </article>
        ))}
      </div>
      {!expanded ? <a className="public-button" href={plansPath}>Compare plans</a> : null}
    </section>
  );
}

function Faq() {
  return (
    <section className="public-section public-section--tight" aria-labelledby="faqTitle">
      <p className="public-kicker">FAQ</p>
      <h2 id="faqTitle">Straight answers.</h2>
      <div className="faq-list">
        <article><h3>Where do phone numbers work?</h3><p>Phone capability uses Twilio number availability and country requirements. Some countries need address or bundle verification before provisioning.</p></article>
        <article><h3>When do payment cards ship?</h3><p>Cards are waitlist-only. The current product supports SaaS billing through Stripe, not agent spending cards.</p></article>
        <article><h3>What is the security model?</h3><p>Bearer tokens are hashed, sessions are HTTP-only cookies, webhooks are signed, and owner-scoped routes are tested for cross-account access.</p></article>
      </div>
    </section>
  );
}

function CardWaitlist() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("loading");
    try {
      await requestJson("/api/v1/waitlist", { method: "POST", body: JSON.stringify({ email, feature: "card" }) });
      setState("done");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return <p className="waitlist-confirmation">You're on the card waitlist.</p>;
  }

  return (
    <form className="waitlist-form" onSubmit={submit}>
      <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="work@example.com" required />
      <button type="submit" disabled={state === "loading"}>{state === "loading" ? "Joining" : "Join waitlist"}</button>
      {state === "error" ? <span>Could not join. Try again later.</span> : null}
    </form>
  );
}

function CodeSnippet({ code }: { code: string }) {
  return <pre className="public-code"><code>{code}</code></pre>;
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  return (
    <div className="docs-code">
      <button type="button" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function PublicSiteFooter() {
  return (
    <footer className="public-footer">
      <span>Barkan</span>
      <nav aria-label="Footer">
        <a href={docsSitePath}>Docs</a>
        <a href="/docs-site/security">Security</a>
        <a href="/docs-site/legal/privacy">Privacy</a>
        <a href="/docs-site/legal/terms">Terms</a>
        <a href="mailto:hello@barkan.dev">Contact</a>
      </nav>
    </footer>
  );
}

function Seo({ title, description }: { title: string; description: string }) {
  document.title = title;
  setMeta("description", description);
  setMeta("og:title", title, "property");
  setMeta("og:description", description, "property");
  setMeta("twitter:card", "summary_large_image");
  return null;
}

function setMeta(name: string, content: string, attr: "name" | "property" = "name") {
  const selector = `meta[${attr}="${name}"]`;
  const element = document.querySelector(selector) ?? document.head.appendChild(document.createElement("meta"));
  element.setAttribute(attr, name);
  element.setAttribute("content", content);
}

function normalizeDocsHref(href?: string): string | undefined {
  if (!href || href.startsWith("http") || href.startsWith("#")) return href;
  if (href.endsWith(".md")) {
    return `/docs-site/${href.replace(/^docs\//, "").replace(/\.md$/, "")}`;
  }
  return href;
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}
