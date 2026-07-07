model: gpt 5.5

# Task 055 — Landing page + public docs: sell what is now real

## Depends on
045, 048, 049 (so docs link real integrations)

## Context
The current marketing surface oversells a demo. Now the product is real: honest, specific marketing converts better. The web app serves both landing (`/`, logged-out) and app; docs pages exist as markdown in `docs/` but aren't published.

## Objective
Conversion-focused landing page + published docs site section, all claims true.

## Spec
- **Landing** (logged-out `/` in `apps/web`):
  - Hero: "Give your AI agent a real identity" — subhead naming the live primitives (phone number, email address) + policies/approvals/audit. CTA: "Start free" → signup; secondary "Read the docs".
  - Live-feel demo strip: animated (CSS/framer-motion, no fake data claims) walkthrough of: agent asks → owner approves → call/email happens → audit line appears.
  - How it works: 3 steps (Create agent → Connect OpenClaw/Hermes/MCP in one command → Set policies and go).
  - Capability sections with real screenshots (take them from the seeded demo account, task 057) and short code snippets (MCP config, SDK call). **Payment card section: styled like the others but with a prominent "Coming soon" badge** — one-paragraph vision (policy-controlled agent spending with human approvals) + email-capture waitlist button (`POST /api/v1/waitlist { email, feature: "card" }` — add this tiny endpoint + collection here, rate-limited, no auth). No screenshots, no fabricated UI for cards.
  - Integrations row: OpenClaw, Hermes, MCP, REST/SDK logos/links.
  - Pricing: the 041 catalog, honest included quantities + overage rates; card listed in the grid as "Coming soon" (no plan gates on it). FAQ (supported countries/phone constraints, when cards ship — answer honestly "waitlist", security model link).
  - Footer: docs, security, privacy, terms, contact. Add `docs/legal/` placeholders task: terms + privacy pages rendered from markdown (get real legal review before launch — note in runbook).
- **Docs site**: `/docs-site` route group in the web app rendering the `docs/**.md` tree (existing `react-markdown` dep) with sidebar nav generated from a manifest; publish: quickstart, integrations (openclaw/hermes/mcp), API reference link (`/docs` Scalar from 045), email/phone/payments setup guides (operator-facing ones stay but get an "operators" section), security, privacy ops.
- SEO/meta: titles, descriptions, OG image, sitemap for landing + docs routes (vite-plugin or manual static generation in build script).

## Implementation steps
1. Landing per spec (respect existing Tailwind design system; dark/light).
2. Docs renderer + manifest + styles (code blocks with copy buttons).
3. Screenshot pass against seeded demo (defer final screenshots until 057 merges; wire image slots now).
4. Meta/sitemap; Lighthouse pass ≥ 90 performance/accessibility on landing.

## Acceptance criteria
- Every factual claim on the landing maps to a shipped task (reviewer checklist in PR description — list claim → task#); the card section contains zero claims of existing functionality — only "Coming soon" + waitlist.
- Waitlist endpoint stores emails, dedupes, rate-limits (5/hr/IP); submitting shows a confirmation state.
- Docs render all existing guides with working internal links.
- Lighthouse ≥ 90 perf/a11y/SEO on `/` (CI budget optional, manual report in PR).

## How to test
```bash
npm --workspace @barkan/web run build && npm --workspace @barkan/web run test -- landing docs
npx lighthouse http://localhost:4888 --only-categories=performance,accessibility,seo --preset=desktop
# Manual: logged-out / -> signup flow -> back to landing when logged out.
```
