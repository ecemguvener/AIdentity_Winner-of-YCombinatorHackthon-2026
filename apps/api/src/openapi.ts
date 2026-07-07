import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface Operation {
  tags: string[];
  summary: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
  "x-internal"?: boolean;
}

type PathItem = Partial<Record<HttpMethod, Operation>>;

const bearerSecurity = [{ bearerAuth: [] }];
const cookieSecurity = [{ cookieAuth: [] }];

const jsonObject = { type: "object", additionalProperties: true };
const ok = response("OK", jsonObject);
const created = response("Created", jsonObject);
const accepted = response("Accepted", jsonObject);
const noContent = { description: "No content" };
const standardErrors = {
  "400": errorResponse("Bad request"),
  "401": errorResponse("Unauthorized"),
  "403": errorResponse("Forbidden"),
  "404": errorResponse("Not found"),
  "409": errorResponse("Conflict"),
  "429": errorResponse("Rate limited"),
  "500": errorResponse("Server error")
};

export const agentOpenApiOperations: Record<string, true> = {};

const paths: Record<string, PathItem> = {
  "/api/v1/agent/whoami": {
    get: agent("identity", "Get authenticated agent identity")
  },
  "/api/v1/agent/audit/recent": {
    get: agent("audit", "List recent audit entries", undefined, [queryParam("limit")])
  },
  "/api/v1/agent/email/address": {
    get: agent("email", "Get agent email address")
  },
  "/api/v1/agent/email/send": {
    post: agent("email", "Send email as the agent", sendEmailBody())
  },
  "/api/v1/agent/email/threads": {
    get: agent("email", "List email threads", undefined, [cursorParam()])
  },
  "/api/v1/agent/email/threads/{threadId}": {
    get: agent("email", "Get email thread", undefined, [pathParam("threadId")])
  },
  "/api/v1/agent/email/threads/{threadId}/reply": {
    post: agent("email", "Reply to email thread", replyEmailBody(), [pathParam("threadId")])
  },
  "/api/v1/agent/email/threads/{threadId}/attachments/{attachmentId}": {
    get: {
      ...agent("email", "Download email attachment", undefined, [pathParam("threadId"), pathParam("attachmentId")]),
      responses: { "200": { description: "Attachment bytes" }, ...standardErrors }
    }
  },
  "/api/v1/agent/approvals/{id}": {
    get: agent("approvals", "Get approval status", undefined, [pathParam("id")])
  },
  "/api/v1/agent/phone/number": {
    get: agent("phone", "Get agent phone number")
  },
  "/api/v1/agent/phone/call": {
    post: agent("phone", "Place outbound call", phoneCallBody())
  },
  "/api/v1/agent/phone/calls": {
    get: agent("phone", "List phone calls", undefined, [cursorParam()])
  },
  "/api/v1/agent/phone/calls/{callId}": {
    get: agent("phone", "Get phone call", undefined, [pathParam("callId")])
  },
  "/api/v1/agent/phone/sms": {
    get: agent("phone", "List SMS conversation", undefined, [queryParam("with"), cursorParam()]),
    post: agent("phone", "Send SMS", smsBody())
  },
  "/api/v1/agent/phone/sms/latest-code": {
    get: agent("phone", "Find latest SMS code", undefined, [queryParam("from"), queryParam("since")])
  },
  "/api/v1/agents": {
    get: owner("agents", "List agent identities"),
    post: owner("agents", "Create agent identity", createAgentBody(), created)
  },
  "/api/v1/agents/{agentId}": {
    get: owner("agents", "Get agent identity", undefined, ok, [pathParam("agentId")]),
    patch: owner("agents", "Update agent identity", updateAgentBody(), ok, [pathParam("agentId")]),
    delete: owner("agents", "Revoke agent identity", undefined, ok, [pathParam("agentId")])
  },
  "/api/v1/agents/{agentId}/tokens": {
    post: owner("agents", "Create identity token", tokenBody(), created, [pathParam("agentId")])
  },
  "/api/v1/agents/{agentId}/tokens/{tokenId}": {
    delete: owner("agents", "Revoke identity token", undefined, ok, [pathParam("agentId"), pathParam("tokenId")])
  },
  "/api/v1/agents/{agentId}/capabilities/{capability}/enable": {
    post: owner("agents", "Enable capability", undefined, accepted, [pathParam("agentId"), pathParam("capability")])
  },
  "/api/v1/agents/{agentId}/capabilities/{capability}/disable": {
    post: owner("agents", "Disable capability", undefined, accepted, [pathParam("agentId"), pathParam("capability")])
  },
  "/api/v1/agents/{agentId}/policies/email": {
    get: owner("agents", "Get email policy", undefined, ok, [pathParam("agentId")]),
    put: owner("agents", "Update email policy", { schema: jsonObject }, ok, [pathParam("agentId")])
  },
  "/api/v1/agents/{agentId}/policies/phone": {
    get: owner("agents", "Get phone policy", undefined, ok, [pathParam("agentId")]),
    put: owner("agents", "Update phone policy", { schema: jsonObject }, ok, [pathParam("agentId")])
  },
  "/api/v1/billing": {
    get: owner("billing", "Get billing account")
  },
  "/api/v1/billing/plans": {
    get: owner("billing", "List billing plans")
  },
  "/api/v1/billing/usage": {
    get: owner("billing", "Get billing usage")
  },
  "/api/v1/billing/checkout": {
    post: owner("billing", "Create Stripe checkout session", { schema: objectSchema({ plan: { type: "string", enum: ["pro", "scale"] } }) })
  },
  "/api/v1/billing/portal": {
    post: owner("billing", "Create Stripe billing portal session")
  },
  "/api/v1/account/export": {
    post: owner("privacy", "Request account export", undefined, accepted)
  },
  "/api/v1/account/export/{exportId}/download": {
    get: {
      ...owner("privacy", "Download account export", undefined, response("ZIP archive", { type: "string", format: "binary" }), [pathParam("exportId"), queryParam("token")]),
      security: []
    }
  },
  "/api/v1/account": {
    delete: owner("privacy", "Delete account", { schema: objectSchema({ password: { type: "string" }, confirm: { type: "string", enum: ["DELETE"] } }) }, accepted)
  },
  "/api/v1/onboarding": {
    patch: owner("onboarding", "Dismiss onboarding checklist", { schema: objectSchema({ dismissed: { type: "boolean" } }, ["dismissed"]) })
  },
  "/api/v1/ops/activation": {
    get: owner("onboarding", "Get activation funnel summary")
  },
  "/api/v1/waitlist": {
    post: {
      ...operation("waitlist", "Join feature waitlist", [], { schema: objectSchema({ email: { type: "string", format: "email" }, feature: { type: "string", enum: ["card"] } }, ["email", "feature"]) }, accepted, []),
      security: []
    }
  },
  "/api/v1/approvals": {
    get: owner("approvals", "List owner approvals")
  },
  "/api/v1/approvals/{approvalId}/approve": {
    post: owner("approvals", "Approve request", { schema: objectSchema({ note: { type: "string" } }) }, ok, [pathParam("approvalId")])
  },
  "/api/v1/approvals/{approvalId}/reject": {
    post: owner("approvals", "Reject request", { schema: objectSchema({ note: { type: "string" } }) }, ok, [pathParam("approvalId")])
  }
};

for (const [path, item] of Object.entries(paths)) {
  for (const method of Object.keys(item)) {
    if (path.startsWith("/api/v1/agent/")) {
      agentOpenApiOperations[`${method.toUpperCase()} ${openApiPathToFastify(path)}`] = true;
    }
  }
}

export function registerOpenApiRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get("/api/v1/openapi.json", async () => buildOpenApiDocument(config));
  app.get("/docs", async (_request, reply) => {
    reply.type("text/html");
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Barkan API Reference</title></head>
<body>
  <script id="api-reference" data-url="/api/v1/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  });
}

export function buildOpenApiDocument(config: AppConfig) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Barkan API",
      version: "0.1.0",
      description: "Agent identity, email, phone, approvals, and billing APIs.",
      license: { name: "Proprietary", identifier: "LicenseRef-Proprietary" }
    },
    servers: [{ url: config.PUBLIC_API_URL }],
    tags: [
      { name: "email", description: "Agent email address, threads, sends, and replies." },
      { name: "phone", description: "Agent phone number, calls, SMS, and verification-code helpers." },
      { name: "agents", description: "Owner-managed agent identities and tokens." },
      { name: "privacy", description: "Account export and deletion." },
      { name: "approvals", description: "Owner approval requests for gated agent actions." },
      { name: "billing", description: "Plans, checkout, usage, and billing portal." },
      { name: "onboarding", description: "First-run activation state and metrics." },
      { name: "waitlist", description: "Public feature waitlists." }
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        cookieAuth: { type: "apiKey", in: "cookie", name: config.SESSION_COOKIE_NAME }
      },
      schemas: {
        ErrorEnvelope: {
          type: "object",
          required: ["error", "message", "legacyError"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "requestId"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                requestId: { type: "string" },
                details: true
              }
            },
            message: { type: "string" },
            legacyError: { type: "string" }
          }
        }
      }
    }
  };
}

function agent(tag: string, summary: string, body?: { schema: unknown }, parameters: unknown[] = []): Operation {
  return operation(tag, summary, bearerSecurity, body, ok, parameters);
}

function owner(tag: string, summary: string, body?: { schema: unknown }, success = ok, parameters: unknown[] = []): Operation {
  return { ...operation(tag, summary, cookieSecurity, body, success, parameters), "x-internal": true };
}

function operation(
  tag: string,
  summary: string,
  security: Array<Record<string, string[]>>,
  body: { schema: unknown } | undefined,
  success: unknown,
  parameters: unknown[]
): Operation {
  return {
    tags: [tag],
    summary,
    operationId: toOperationId(summary),
    security,
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body.schema } } } } : {}),
    responses: { "200": success, ...standardErrors }
  };
}

function response(description: string, schema: unknown) {
  return { description, content: { "application/json": { schema } } };
}

function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } };
}

function pathParam(name: string) {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

function queryParam(name: string) {
  return { name, in: "query", required: false, schema: { type: "string" } };
}

function cursorParam() {
  return queryParam("cursor");
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function sendEmailBody() {
  return { schema: objectSchema({ to: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, html: { type: "string" }, cc: { type: "array", items: { type: "string" } }, idempotencyKey: { type: "string" } }, ["to", "subject", "text"]) };
}

function replyEmailBody() {
  return { schema: objectSchema({ text: { type: "string" }, idempotencyKey: { type: "string" } }, ["text"]) };
}

function phoneCallBody() {
  return { schema: objectSchema({ to: { type: "string" }, task: { type: "string" }, context: { type: "string" }, recipientName: { type: "string" } }, ["to", "task"]) };
}

function smsBody() {
  return { schema: objectSchema({ to: { type: "string" }, body: { type: "string" }, idempotencyKey: { type: "string" } }, ["to", "body"]) };
}

function createAgentBody() {
  return { schema: objectSchema({ name: { type: "string" }, description: { type: "string" }, runtime: { type: "string", enum: ["openclaw", "hermes", "api", "other"] }, capabilities: jsonObject, approvalMode: { type: "string", enum: ["always", "policy", "autonomous"] } }, ["name"]) };
}

function updateAgentBody() {
  return { schema: objectSchema({ name: { type: "string" }, description: { type: ["string", "null"] }, approvalMode: { type: "string", enum: ["always", "policy", "autonomous"] }, status: { type: "string", enum: ["active", "paused"] } }) };
}

function tokenBody() {
  return { schema: objectSchema({ name: { type: "string" } }) };
}

function openApiPathToFastify(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function toOperationId(summary: string): string {
  const words = summary.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/);
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }).join("");
}
