import quickstart from "../../../../docs/openclaw-identity-layer.md?raw";
import openclaw from "../../../../docs/integrations/openclaw.md?raw";
import hermes from "../../../../docs/integrations/hermes.md?raw";
import mcp from "../../../../docs/integrations/mcp.md?raw";
import authentication from "../../../../docs/api/authentication.md?raw";
import emailApi from "../../../../docs/api/email.md?raw";
import phoneApi from "../../../../docs/api/phone.md?raw";
import emailSetup from "../../../../docs/email-setup.md?raw";
import phoneSetup from "../../../../docs/phone-setup.md?raw";
import paymentsSetup from "../../../../docs/payments-setup.md?raw";
import security from "../../../../docs/security.md?raw";
import privacyOps from "../../../../docs/privacy-operations.md?raw";
import operations from "../../../../docs/operations.md?raw";
import terms from "../../../../docs/legal/terms.md?raw";
import privacy from "../../../../docs/legal/privacy.md?raw";

export interface DocsPageEntry {
  slug: string;
  title: string;
  section: string;
  markdown: string;
}

export const docsManifest: DocsPageEntry[] = [
  { slug: "quickstart", title: "Quickstart", section: "Start", markdown: quickstart },
  { slug: "integrations/openclaw", title: "OpenClaw", section: "Integrations", markdown: openclaw },
  { slug: "integrations/hermes", title: "Hermes", section: "Integrations", markdown: hermes },
  { slug: "integrations/mcp", title: "MCP", section: "Integrations", markdown: mcp },
  { slug: "api/authentication", title: "Authentication", section: "API", markdown: authentication },
  { slug: "api/email", title: "Email API", section: "API", markdown: emailApi },
  { slug: "api/phone", title: "Phone API", section: "API", markdown: phoneApi },
  { slug: "operators/email", title: "Email Setup", section: "Operators", markdown: emailSetup },
  { slug: "operators/phone", title: "Phone Setup", section: "Operators", markdown: phoneSetup },
  { slug: "operators/payments", title: "Payments Setup", section: "Operators", markdown: paymentsSetup },
  { slug: "security", title: "Security", section: "Trust", markdown: security },
  { slug: "privacy-operations", title: "Privacy Operations", section: "Trust", markdown: privacyOps },
  { slug: "operations", title: "Operations", section: "Trust", markdown: operations },
  { slug: "legal/terms", title: "Terms", section: "Legal", markdown: terms },
  { slug: "legal/privacy", title: "Privacy", section: "Legal", markdown: privacy }
];

export function findDocsPage(path: string): DocsPageEntry {
  const slug = path.replace(/^\/docs-site\/?/, "").replace(/\/$/, "") || "quickstart";
  return docsManifest.find((page) => page.slug === slug) ?? docsManifest[0]!;
}
