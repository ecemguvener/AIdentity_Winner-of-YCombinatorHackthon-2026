import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AgentDocument, Collections, EmailMessageDocument } from "./db.js";
import { requireAuth } from "./auth.js";
import { authenticateAgentRequest } from "./agent-auth.js";
import { ApiError, codeForStatus, type ApiErrorCode } from "./errors.js";
import {
  getAgentEmailThread,
  listAgentEmailThreads,
  replyToAgentEmailThread,
  sendAgentEmail
} from "./email-service.js";
import { createEmailInboundClient, createEmailProvider, type EmailProvider } from "./providers/email-provider.js";

// ---------------------------------------------------------------------------
// Email Capability Add-on
//
// A plug-in communication layer that lets an existing agent identity send and
// receive *real* email as a personal assistant. The existing agent is the
// brain; this exposes tools it calls.
//
// Like payments, the store is keyed by an opaque account id so one engine
// serves two front doors:
//   - agent-facing routes, authenticated with a Bearer identity token
//     (account = the in-memory agent identity id)
//   - dashboard routes, authenticated with the owner's session, scoped per
//     agent identity (account = the site id the dashboard manages)
//
// Provider mode is explicit. Live uses Resend; mock logs and returns synthetic ids.
// ---------------------------------------------------------------------------

type EmailIdentityStatus = "active" | "paused";

/** Error carrying an HTTP status so route handlers can translate cleanly. */
export class EmailError extends ApiError {
  constructor(
    readonly status: number,
    message: string,
    code: ApiErrorCode = codeForStatus(status)
  ) {
    super(status, code, message);
    this.name = "EmailError";
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendSchema = z.object({
  to: z.string().email(),
  cc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000).optional(),
  text: z.string().min(1).max(10_000).optional(),
  html: z.string().min(1).max(20_000).optional(),
  threadId: z.string().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  approved: z.boolean().optional()
}).refine((value) => Boolean(value.body ?? value.text), {
  message: "text is required",
  path: ["text"]
});

const requestSchema = z.object({
  request: z.string().min(1).max(2000),
  to: z.string().email().optional(),
  approved: z.boolean().optional()
});

const replySchema = z.object({
  text: z.string().min(1).max(10_000),
  idempotencyKey: z.string().min(1).max(200).optional()
});

// ---------------------------------------------------------------------------
// Natural-language drafting + reply summaries: OpenAI Responses API → heuristic
// ---------------------------------------------------------------------------

export interface GeneratedEmail {
  to: string | null;
  recipientName: string | null;
  subject: string;
  body: string;
  parsedBy: "openai" | "heuristic";
}

export async function sendSiteEmailFromText(
  collections: Collections,
  config: AppConfig,
  provider: EmailProvider,
  agent: AgentDocument,
  prompt: string,
  to?: string
) {
  const generated = await draftEmail(prompt, agent.name, config);
  const recipient = to ?? generated.to ?? undefined;
  if (!recipient) {
    throw new EmailError(422, `couldn't find a recipient email in: "${prompt}". Add the recipient's email address.`);
  }
  const result = await sendAgentEmail(collections, config, provider, {
    agent,
    to: recipient,
    subject: generated.subject,
    text: generated.body,
    parsedBy: generated.parsedBy
  });
  return { ...result, parsed: { ...generated, to: recipient } };
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string" },
    recipient_name: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" }
  },
  required: ["subject", "body"],
  additionalProperties: false
} as const;

export async function draftEmail(prompt: string, senderName: string, config: AppConfig): Promise<GeneratedEmail> {
  if (config.OPENAI_API_KEY) {
    try {
      return await draftWithOpenAI(prompt, senderName, config);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[email] OpenAI draft failed, using heuristic:", (error as Error).message);
    }
  }
  return draftHeuristic(prompt, senderName);
}

async function draftWithOpenAI(prompt: string, senderName: string, config: AppConfig): Promise<GeneratedEmail> {
  const instructions =
    "You draft an email on behalf of a sender based on the user's instruction. " +
    `The sender is "${senderName}". ` +
    "Mirror the tone, register, and intent of the user's instruction in the email: if the instruction is blunt, be blunt; if casual, casual; if urgent or firm, keep that edge; if formal, formal; if warm, warm. " +
    "Do NOT sanitize, soften, over-formalize, or add pleasantries, hedging, apologies, or filler the user did not imply. Keep it concise and say exactly what the instruction wants said. " +
    "From the user's instruction, extract the recipient's email address into `to` if one is present (otherwise omit it), " +
    "extract the recipient's name into `recipient_name` if present, and write a `subject` (max 8 words) that fits the same tone. " +
    "Write a plain-text `body`. Use a greeting and sign-off only if they fit the tone; when you sign off, sign as the sender. " +
    "Do not invent an email address.";

  const model = process.env.OPENAI_EMAIL_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 600,
      text: { format: { type: "json_schema", name: "email_draft", schema: DRAFT_SCHEMA, strict: false } }
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI responses ${response.status}: ${responseText.slice(0, 300)}`);
  }
  const outputText = readOpenAIOutputText(responseText);
  if (!outputText) {
    throw new Error("OpenAI returned no output");
  }
  const raw = JSON.parse(outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
  const to = typeof raw.to === "string" ? extractEmail(raw.to) : extractEmail(prompt);
  return {
    to,
    recipientName: typeof raw.recipient_name === "string" ? raw.recipient_name.trim() || null : null,
    subject: String(raw.subject ?? "").trim() || defaultSubject(prompt),
    body: String(raw.body ?? "").trim() || defaultBody(prompt, senderName, null),
    parsedBy: "openai"
  };
}

function draftHeuristic(prompt: string, senderName: string): GeneratedEmail {
  const to = extractEmail(prompt);
  const recipientName = extractRecipientName(prompt);
  return {
    to,
    recipientName,
    subject: defaultSubject(prompt),
    body: defaultBody(prompt, senderName, recipientName),
    parsedBy: "heuristic"
  };
}

export interface ReplySummary {
  summary: string;
  suggestedReply: string;
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    suggested_reply: { type: "string" }
  },
  required: ["summary", "suggested_reply"],
  additionalProperties: false
} as const;

export async function summarizeReply(subject: string, body: string, config: AppConfig): Promise<ReplySummary> {
  if (config.OPENAI_API_KEY && body) {
    try {
      const model = process.env.OPENAI_EMAIL_MODEL || "gpt-4o-mini";
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model,
          instructions:
            "Summarize this inbound email reply in one sentence (`summary`) and draft a short, polite `suggested_reply` the assistant could send back.",
          input: [{ role: "user", content: [{ type: "input_text", text: `Subject: ${subject}\n\n${body}` }] }],
          max_output_tokens: 400,
          text: { format: { type: "json_schema", name: "reply_summary", schema: SUMMARY_SCHEMA, strict: false } }
        })
      });
      const responseText = await response.text();
      if (response.ok) {
        const outputText = readOpenAIOutputText(responseText);
        if (outputText) {
          const raw = JSON.parse(outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
          return {
            summary: String(raw.summary ?? "").trim() || summarizeHeuristic(body),
            suggestedReply: String(raw.suggested_reply ?? "").trim() || "Thanks for getting back to me — I'll follow up shortly."
          };
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[email] OpenAI summary failed, using heuristic:", (error as Error).message);
    }
  }
  return { summary: summarizeHeuristic(body), suggestedReply: "Thanks for getting back to me — I'll follow up shortly." };
}

// ---------------------------------------------------------------------------
// Heuristic text helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function extractEmail(text: string): string | null {
  return text.match(EMAIL_RE)?.[0] ?? null;
}

function extractRecipientName(prompt: string): string | null {
  const match = prompt.match(/\b(?:email|tell|ask|message|write to|reach out to|contact)\s+([A-Z][a-z]+)\b/);
  return match ? match[1]! : null;
}

function defaultSubject(prompt: string): string {
  const ask = prompt.match(/\b(?:ask|tell|let .* know|about|regarding|re:?)\s+(?:them\s+|him\s+|her\s+)?(?:if\s+|whether\s+|about\s+)?(.+)/i);
  const core = (ask?.[1] ?? prompt).replace(EMAIL_RE, "").replace(/[.?!]+$/, "").trim();
  const words = core.split(/\s+/).slice(0, 8).join(" ");
  const subject = words.charAt(0).toUpperCase() + words.slice(1);
  return subject.length > 4 ? subject : "Quick question";
}

function defaultBody(prompt: string, senderName: string, recipientName: string | null): string {
  const ask = prompt
    .replace(EMAIL_RE, "")
    .replace(/\b(?:email|message|write to|reach out to|contact)\s+[A-Z][a-z]+\b/, "")
    .replace(/^\s*and\s+/i, "")
    .trim();
  const request = ask.charAt(0).toUpperCase() + ask.slice(1) || "I wanted to reach out.";
  // Heuristic fallback (no LLM): carry the instruction directly rather than
  // wrapping it in pleasantries. A greeting is only added when we know a name.
  const greeting = recipientName ? `${recipientName},\n\n` : "";
  return `${greeting}${request}\n\n— ${senderName}`;
}

function summarizeHeuristic(body: string): string {
  const firstLine = body.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  return summary || "(empty reply)";
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function readOpenAIOutputText(responseText: string): string {
  const response = JSON.parse(responseText) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  return (
    response.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content): content is { type: string; text: string } => content.type === "output_text" && typeof content.text === "string")
      .map((content) => content.text)
      .join("") ?? ""
  );
}

// ---------------------------------------------------------------------------
// Inbound payload normalization — tolerant of Resend/SES inbound shapes.
// ---------------------------------------------------------------------------

export interface NormalizedInbound {
  from: string;
  toCandidates: string[];
  subject: string;
  text: string;
  inReplyTo: string | null;
  messageId: string | null;
}

export function normalizeInbound(body: unknown): NormalizedInbound {
  const data = unwrapData(body);
  const headers = readHeaders(data.headers);
  const from = firstAddress(data.from) ?? "";
  const toCandidates = collectAddresses(data.to);
  const text = typeof data.text === "string" && data.text ? data.text : stripHtml(typeof data.html === "string" ? data.html : "");
  return {
    from,
    toCandidates,
    subject: typeof data.subject === "string" ? data.subject.trim() : "",
    text,
    inReplyTo: asString(data.in_reply_to) ?? headers["in-reply-to"] ?? null,
    messageId: asString(data.message_id) ?? headers["message-id"] ?? null
  };
}

function unwrapData(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (record.data && typeof record.data === "object") {
      return record.data as Record<string, unknown>;
    }
    return record;
  }
  return {};
}

function readHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object") {
        const name = asString((entry as Record<string, unknown>).name);
        const headerValue = asString((entry as Record<string, unknown>).value);
        if (name && headerValue) out[name.toLowerCase()] = headerValue;
      }
    }
  } else if (value && typeof value === "object") {
    for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
      const stringValue = asString(headerValue);
      if (stringValue) out[name.toLowerCase()] = stringValue;
    }
  }
  return out;
}

function collectAddresses(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(firstAddress).filter((address): address is string => Boolean(address));
}

function firstAddress(value: unknown): string | null {
  if (typeof value === "string") {
    return extractEmail(value) ?? (value.includes("@") ? value.trim() : null);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = asString(record.address) ?? asString(record.email);
    if (candidate) return extractEmail(candidate) ?? candidate;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Resend webhook signature verification (Svix). The signing secret looks like
// `whsec_<base64>`. When RESEND_WEBHOOK_SECRET is a plain string instead, a
// simple X-Webhook-Secret header check is used (handy for local testing).
// ---------------------------------------------------------------------------

export function verifyResendSignature(secret: string, headers: Record<string, unknown>, rawBody: string): boolean {
  const id = asString(headers["svix-id"]);
  const timestamp = asString(headers["svix-timestamp"]);
  const signatureHeader = asString(headers["svix-signature"]);
  if (!id || !timestamp || !signatureHeader) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return false; // reject stale/replayed deliveries (5 minute tolerance)
  }
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(key, "base64");
  } catch {
    return false;
  }
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return signatureHeader.split(" ").some((part) => {
    const commaIndex = part.indexOf(",");
    const value = commaIndex === -1 ? part : part.slice(commaIndex + 1);
    return timingSafeEqualStrings(value, expected);
  });
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBytes, bBytes);
}

// ---------------------------------------------------------------------------
// Routes — agent-facing (Bearer identity token)
// ---------------------------------------------------------------------------

export function registerEmailRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig,
  provider: EmailProvider = createEmailProvider(config)
) {
  const handleSend = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await loadAgentEmailContext(request, collections);
    const payload = sendSchema.parse(request.body ?? {});
    const messageText = payload.text ?? payload.body!;
    const idempotencyKey = payload.idempotencyKey ?? readIdempotencyHeader(request);
    return runEmail(reply, async () => {
      const { message, replayed } = await sendAgentEmail(collections, config, provider, {
        agent: context.agent,
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        text: messageText,
        html: payload.html,
        threadId: payload.threadId,
        idempotencyKey
      });
      return reply.code(replayed ? 200 : 201).send(serializePersistentSend(message));
    });
  };

  app.post("/api/tools/email/request", async (request, reply) => {
    const context = await loadAgentEmailContext(request, collections);
    const payload = requestSchema.parse(request.body ?? {});
    return runEmail(reply, async () => {
      const generated = await draftEmail(payload.request, context.agent.name, config);
      const to = payload.to ?? generated.to ?? undefined;
      if (!to) {
        throw new EmailError(
          422,
          `couldn't find a recipient email in: "${payload.request}". Ask the user for the recipient's email address, then pass it as "to".`
        );
      }
      const { message, replayed } = await sendAgentEmail(collections, config, provider, {
        agent: context.agent,
        to,
        subject: generated.subject,
        text: generated.body,
        idempotencyKey: readIdempotencyHeader(request),
        parsedBy: generated.parsedBy
      });
      return reply.code(replayed ? 200 : 201).send({ ...serializePersistentSend(message), parsed: serializeParsed({ ...generated, to }) });
    });
  });

  app.post("/api/tools/email/send", handleSend);
  app.post("/api/v1/agent/email/send", handleSend);

  app.get("/api/v1/agent/email/threads", async (request) => {
    const context = await loadAgentEmailContext(request, collections);
    const query = request.query as { cursor?: string };
    return listAgentEmailThreads(collections, context.agent, query.cursor);
  });

  app.get("/api/v1/agent/email/threads/:threadId", async (request) => {
    const context = await loadAgentEmailContext(request, collections);
    const { threadId } = request.params as { threadId: string };
    const { thread, messages } = await getAgentEmailThread(collections, context.agent, threadId);
    return {
      thread: {
        id: thread._id.toHexString(),
        counterparty: thread.counterpartyEmail,
        subject: thread.subject,
        lastMessageAt: thread.lastMessageAt.toISOString(),
        messageCount: thread.messageCount
      },
      messages: messages.map(serializePersistentMessage)
    };
  });

  app.post("/api/v1/agent/email/threads/:threadId/reply", async (request, reply) => {
    const context = await loadAgentEmailContext(request, collections);
    const { threadId } = request.params as { threadId: string };
    const payload = replySchema.parse(request.body ?? {});
    const { message, replayed } = await replyToAgentEmailThread(collections, config, provider, {
      agent: context.agent,
      threadId,
      text: payload.text,
      idempotencyKey: payload.idempotencyKey ?? readIdempotencyHeader(request)
    });
    return reply.code(replayed ? 200 : 201).send(serializePersistentSend(message));
  });

  app.get("/api/v1/agent/email/threads/:threadId/attachments/:attachmentId", async (request, reply) => {
    const context = await loadAgentEmailContext(request, collections);
    const { threadId, attachmentId } = request.params as { threadId: string; attachmentId: string };
    const { messages } = await getAgentEmailThread(collections, context.agent, threadId);
    const message = messages.find((candidate) =>
      candidate.attachments?.some((attachment) => attachment.providerAttachmentId === attachmentId)
    );
    const attachment = message?.attachments?.find((candidate) => candidate.providerAttachmentId === attachmentId);
    if (!message || !attachment || !message.providerMessageId) {
      throw new ApiError(404, "not_found", "attachment not found");
    }
    if (attachment.sizeBytes > 25 * 1024 * 1024) {
      throw new ApiError(400, "validation_failed", "attachment exceeds 25MB limit");
    }
    const inboundClient = createEmailInboundClient(config);
    const file = await inboundClient.getAttachment(message.providerMessageId, attachmentId);
    reply.header("content-type", file.contentType);
    reply.header("content-disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"`);
    return Buffer.from(file.data);
  });

  app.post("/api/tools/email/pause", async (request, reply) => {
    const context = await loadAgentEmailContext(request, collections);
    return runEmail(reply, async () => serializeEmailAccount(await setAgentEmailAccountStatus(collections, context.agent, "paused"), config));
  });

  app.post("/api/tools/email/resume", async (request, reply) => {
    const context = await loadAgentEmailContext(request, collections);
    return runEmail(reply, async () => serializeEmailAccount(await setAgentEmailAccountStatus(collections, context.agent, "active"), config));
  });

  app.get("/api/identity/:agentId/email-activity", async (request, reply) => {
    const context = await loadAgentEmailContext(request, collections);
    const { agentId } = request.params as { agentId: string };
    if (context.agent._id.toHexString() !== agentId) throw new ApiError(403, "forbidden", "identity token does not match requested agent");
    return getPersistentEmailActivity(collections, context.agent, config);
  });
}

// ---------------------------------------------------------------------------
// Routes — dashboard, per agent identity (session + ownership), scoped by site
// ---------------------------------------------------------------------------

export function registerSiteEmailRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig,
  provider: EmailProvider = createEmailProvider(config)
) {
  const resolveSite = async (request: FastifyRequest, reply: FastifyReply): Promise<AgentDocument | null> => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) return null;
    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      throw new ApiError(404, "not_found", "agent identity not found");
    }
    // The legacy "site" id is an agent id since task 010 (or a pre-migration
    // legacy site id from a stale dashboard tab).
    const agent = await collections.agents.findOne({
      ownerUserId: authContext.user._id,
      status: { $ne: "revoked" },
      $or: [{ _id: siteId }, { legacySiteId: siteId }]
    });
    if (!agent) {
      throw new ApiError(404, "not_found", "agent identity not found");
    }
    return agent;
  };

  app.get("/api/sites/:siteId/email-activity", async (request, reply) => {
    const agent = await resolveSite(request, reply);
    if (!agent) return;
    return getPersistentEmailActivity(collections, agent, config);
  });

  app.post("/api/sites/:siteId/email/request", async (request, reply) => {
    const agent = await resolveSite(request, reply);
    if (!agent) return;
    const payload = requestSchema.parse(request.body ?? {});
    return runEmail(reply, async () => {
      const generated = await draftEmail(payload.request, agent.name, config);
      const to = payload.to ?? generated.to ?? undefined;
      if (!to) {
        throw new EmailError(422, `couldn't find a recipient email in: "${payload.request}". Add the recipient's email address.`);
      }
      const { message } = await sendAgentEmail(collections, config, provider, {
        agent,
        to,
        subject: generated.subject,
        text: generated.body,
        parsedBy: generated.parsedBy
      });
      return reply.code(201).send({ ...serializePersistentSend(message), parsed: serializeParsed({ ...generated, to }) });
    });
  });

  app.post("/api/sites/:siteId/email/send", async (request, reply) => {
    const agent = await resolveSite(request, reply);
    if (!agent) return;
    const payload = sendSchema.parse(request.body ?? {});
    return runEmail(reply, async () => {
      const { message } = await sendAgentEmail(collections, config, provider, {
        agent,
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        text: payload.text ?? payload.body!,
        html: payload.html,
        threadId: payload.threadId,
        idempotencyKey: payload.idempotencyKey
      });
      return reply.code(201).send(serializePersistentSend(message));
    });
  });

  app.post("/api/sites/:siteId/email/pause", async (request, reply) => {
    const agent = await resolveSite(request, reply);
    if (!agent) return;
    return runEmail(reply, async () => serializeEmailAccount(await setAgentEmailAccountStatus(collections, agent, "paused"), config));
  });

  app.post("/api/sites/:siteId/email/resume", async (request, reply) => {
    const agent = await resolveSite(request, reply);
    if (!agent) return;
    return runEmail(reply, async () => serializeEmailAccount(await setAgentEmailAccountStatus(collections, agent, "active"), config));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runEmail(reply: FastifyReply, fn: () => unknown | Promise<unknown>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EmailError) {
      throw error;
    }
    throw error;
  }
}

async function loadAgentEmailContext(
  request: FastifyRequest,
  collections: Collections
): Promise<{ agent: AgentDocument }> {
  const context = await authenticateAgentRequest(request, collections);
  if (!context) {
    throw new ApiError(401, "unauthorized", "missing or invalid identity token");
  }
  return { agent: context.agent };
}

async function getPersistentEmailActivity(collections: Collections, agent: AgentDocument, config: AppConfig) {
  const account = await collections.emailAccounts.findOne({ agentId: agent._id });
  const messages = await collections.emailMessages
    .find({ agentId: agent._id })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
  return {
    account_id: agent._id.toHexString(),
    email_identity: account
      ? {
          email_identity_id: account._id.toHexString(),
          email_address: account.address,
          display_name: account.displayName,
          provider: config.PROVIDER_MODE_EMAIL === "live" ? "resend" : "mock",
          status: account.status,
          created_at: account.createdAt.toISOString()
        }
      : null,
    messages: messages.map(serializePersistentMessage),
    reply_notifications: messages
      .filter((message) => message.direction === "inbound" && message.summary)
      .map((message) => ({
        id: message._id.toHexString(),
        email_message_id: message._id.toHexString(),
        thread_id: message.threadId.toHexString(),
        from_email: message.fromEmail,
        subject: message.subject,
        summary: message.summary,
        suggested_reply: message.suggestedReply ?? "",
        status: message.readAt ? "read" : "unread",
        created_at: message.createdAt.toISOString()
      }))
  };
}

async function setAgentEmailAccountStatus(
  collections: Collections,
  agent: AgentDocument,
  status: EmailIdentityStatus
){
  const now = new Date();
  const account = await collections.emailAccounts.findOneAndUpdate(
    { agentId: agent._id },
    { $set: { status, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!account) {
    throw new EmailError(404, "no email identity for this agent");
  }
  await collections.agents.updateOne(
    { _id: agent._id },
    { $set: { "capabilities.email": status === "active", updatedAt: now } }
  );
  return account;
}

function serializePersistentSend(message: EmailMessageDocument) {
  return {
    ok: message.status === "sent" || message.status === "delivered",
    message_id: message._id.toHexString(),
    thread_id: message.threadId.toHexString(),
    provider_message_id: message.providerMessageId ?? null,
    from: message.fromEmail,
    to: message.toEmail,
    subject: message.subject,
    status: message.status
  };
}

function serializeParsed(parsed: GeneratedEmail) {
  return {
    to: parsed.to,
    recipient_name: parsed.recipientName,
    subject: parsed.subject,
    body: parsed.body,
    parsed_by: parsed.parsedBy
  };
}

function serializePersistentMessage(message: EmailMessageDocument) {
  return {
    id: message._id.toHexString(),
    thread_id: message.threadId.toHexString(),
    direction: message.direction,
    from_email: message.fromEmail,
    to_email: message.toEmail,
    cc: message.cc ?? [],
    subject: message.subject,
    body: message.textBody,
    html: message.htmlBody ?? null,
    provider_message_id: message.providerMessageId ?? null,
    status: message.status,
    parsed_by: message.parsedBy ?? null,
    summary: message.summary ?? null,
    suggested_reply: message.suggestedReply ?? null,
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size_bytes: attachment.sizeBytes,
      id: attachment.providerAttachmentId ?? null
    })),
    created_at: message.createdAt.toISOString()
  };
}

function readIdempotencyHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serializeEmailAccount(
  identity: { _id: ObjectId; address: string; displayName: string; status: EmailIdentityStatus; createdAt: Date },
  config: AppConfig
) {
  return {
    email_identity_id: identity._id.toHexString(),
    email_address: identity.address,
    display_name: identity.displayName,
    provider: config.PROVIDER_MODE_EMAIL === "live" ? "resend" : "mock",
    status: identity.status,
    created_at: identity.createdAt.toISOString()
  };
}

function parseObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}
