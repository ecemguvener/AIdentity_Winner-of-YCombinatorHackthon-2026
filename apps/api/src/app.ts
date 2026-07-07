import crypto from "node:crypto";
import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { buildCorsOptionsForRequest, isPublicCorsPath, isTrustedDashboardOrigin } from "./cors.js";
import { ApiError, buildErrorPayload, codeForStatus, validationApiError } from "./errors.js";
import { registerAgentRoutes } from "./agents-routes.js";
import { registerApprovalRoutes } from "./approvals.js";
import { registerAuditRoutes } from "./audit-routes.js";
import { registerAuthRoutes } from "./auth.js";
import { requireAuth } from "./auth.js";
import { registerDashboardChatRoutes } from "./dashboard-chat.js";
import { registerEmailRoutes, registerSiteEmailRoutes } from "./email.js";
import { registerEmailApprovalExecutor } from "./email-service.js";
import { createEmailProvider } from "./providers/email-provider.js";
import { registerEmailProvisioner } from "./email-provisioning.js";
import { registerIdentityRoutes } from "./identity.js";
import { registerPaymentRoutes, registerSitePaymentRoutes } from "./payments.js";
import { registerPolicyRoutes } from "./policies.js";
import { registerSiteRoutes } from "./sites.js";
import { registerRawBodyParsers } from "./webhooks/framework.js";
import { registerWebhookRoutes } from "./webhooks/routes.js";
import { ensureAgentDomain, getDomainStatus } from "./providers/resend-domain.js";

export async function buildApp(config: AppConfig, collections: Collections) {
  const app = fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info"
    },
    bodyLimit: 8 * 1024 * 1024,
    genReqId: () => crypto.randomBytes(8).toString("hex")
  });

  // Keep the exact raw bytes (JSON and urlencoded) on request.rawBody so
  // webhook signature verification works over what was actually received.
  registerRawBodyParsers(app);

  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;
    if (isAgentTokenRoute(url)) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          groupId: "agent-token",
          keyGenerator: agentTokenRateLimitKey,
          errorResponseBuilder: (_request, context) =>
            new ApiError(429, "rate_limited", "rate limit exceeded", { retryAfter: context.after })
        }
      };
    } else if (isAuthRateLimitedRoute(url)) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          groupId: "auth",
          keyGenerator: (request) => request.ip,
          exponentialBackoff: true,
          errorResponseBuilder: (_request, context) =>
            new ApiError(429, "rate_limited", "rate limit exceeded", { retryAfter: context.after })
        }
      };
    }
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.API_RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, "rate_limited", "rate limit exceeded", { retryAfter: context.after })
  });
  await app.register(cors, {
    delegator: (request, callback) => {
      callback(null, buildCorsOptionsForRequest(config, request));
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("preHandler", async (request, reply) => {
    const origin = request.headers.origin;
    if (
      typeof origin === "string" &&
      !isPublicCorsPath(request.url) &&
      !isTrustedDashboardOrigin(origin, config)
    ) {
      throw new ApiError(403, "forbidden", "origin is not allowed");
    }
  });

  app.addHook("preSerialization", async (request, reply, payload) => {
    if (reply.statusCode >= 400 && isRecord(payload)) {
      if (isRecord(payload.error) && typeof payload.error.code === "string") {
        return payload;
      }

      const message =
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.message === "string"
            ? payload.message
            : "invalid request";
      const details = payload.details;
      return buildErrorPayload(
        new ApiError(reply.statusCode, codeForStatus(reply.statusCode), message, details),
        request.id
      );
    }

    return payload;
  });

  app.setNotFoundHandler((_request, reply) => {
    throw new ApiError(404, "not_found", "route not found");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const apiError = validationApiError(error);
      reply.code(apiError.statusCode).send(buildErrorPayload(apiError, request.id));
      return;
    }

    if (error instanceof ApiError) {
      reply.code(error.statusCode).send(buildErrorPayload(error, request.id));
      return;
    }

    const statusCode = readStatusCode(error);
    if (statusCode >= 400 && statusCode < 500) {
      const apiError = new ApiError(statusCode, codeForStatus(statusCode), safeClientErrorMessage(error, statusCode));
      reply.code(apiError.statusCode).send(buildErrorPayload(apiError, request.id));
      return;
    }

    request.log.error({ error }, "request failed");
    const apiError = new ApiError(500, "internal", "internal server error");
    reply.code(500).send(buildErrorPayload(apiError, request.id));
  });

  app.get("/api/health", async () => ({ ok: true }));
  registerEmailProvisioner(collections, config);
  const emailProvider = createEmailProvider(config);
  registerEmailApprovalExecutor(collections, config, emailProvider);
  app.get("/api/v1/ops/email-domain", async (request, reply) => {
    await requireAuth(request, reply, collections, config);
    const status = config.PROVIDER_MODE_EMAIL === "live"
      ? await ensureAgentDomain(config)
      : await getDomainStatus(config, mockMissingResendClient(config.EMAIL_AGENT_DOMAIN));
    return { domain: status };
  });

  registerAgentRoutes(app, collections, config);
  registerApprovalRoutes(app, collections, config);
  registerAuditRoutes(app, collections, config);
  registerAuthRoutes(app, collections, config);
  registerDashboardChatRoutes(app, collections, config);
  registerEmailRoutes(app, collections, config, emailProvider);
  registerSiteEmailRoutes(app, collections, config, emailProvider);
  registerIdentityRoutes(app, collections, config);
  registerPaymentRoutes(app, collections, config);
  registerPolicyRoutes(app, collections, config);
  registerSitePaymentRoutes(app, collections, config);
  registerSiteRoutes(app, collections, config);
  registerWebhookRoutes(app, collections, config);

  if (config.PROVIDER_MODE_EMAIL === "live") {
    setImmediate(() => {
      void ensureAgentDomain(config).then((status) => {
        if (!status.verified) {
          app.log.warn({ records: status.records }, "Resend email domain is not verified");
        }
      }).catch((error) => {
        app.log.warn({ error }, "could not verify Resend email domain");
      });
    });
  }

  return app;
}

function mockMissingResendClient(domain: string) {
  return {
    domains: {
      create: async () => ({ data: { id: "mock", name: domain, status: "not_created", records: [] }, error: null }),
      list: async () => ({ data: { data: [] }, error: null }),
      get: async () => ({ data: null, error: { message: "not found" } }),
      verify: async () => ({ data: { id: "mock", status: "not_created" }, error: null })
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAgentTokenRoute(url: string): boolean {
  return url.startsWith("/api/tools/") || url.startsWith("/api/identity/") || url.startsWith("/api/v1/agent/");
}

function isAuthRateLimitedRoute(url: string): boolean {
  return ["/api/auth/login", "/api/auth/signup", "/api/auth/check-email"].includes(url);
}

function agentTokenRateLimitKey(request: { headers: Record<string, unknown>; ip: string }): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return `ip:${request.ip}`;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return `ip:${request.ip}`;
  }

  return `token:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function readStatusCode(error: unknown): number {
  if (!isRecord(error)) {
    return 500;
  }

  const statusCode = error.statusCode ?? error.status;
  return typeof statusCode === "number" ? statusCode : 500;
}

function safeClientErrorMessage(error: unknown, statusCode: number): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return statusCode === 404 ? "route not found" : "invalid request";
}
