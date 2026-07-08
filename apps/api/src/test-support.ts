import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections, EmailMessageDocument, EmailThreadDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { requireAuth } from "./auth.js";
import { emitOwnerEvent } from "./approvals.js";

const inboundEmailSchema = z.object({
  agentId: z.string(),
  from: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1)
});

const postCallSchema = z.object({
  callId: z.string(),
  summary: z.string().optional()
});

const billingPlanSchema = z.object({
  plan: z.enum(["free", "pro", "scale"])
});

export function registerTestSupportRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  if (config.NODE_ENV !== "test") return;

  app.post("/api/test-support/inbound-email", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = inboundEmailSchema.parse(request.body ?? {});
    const agentId = objectId(payload.agentId, "agentId");
    const agent = await collections.agents.findOne({ _id: agentId, ownerUserId: authContext.user._id });
    if (!agent) throw new ApiError(404, "not_found", "agent not found");
    const account = await collections.emailAccounts.findOne({ agentId });
    if (!account) throw new ApiError(409, "validation_failed", "agent has no email account");
    const now = new Date();
    const thread: EmailThreadDocument = {
      _id: new ObjectId(),
      agentId,
      subject: payload.subject,
      counterpartyEmail: payload.from,
      lastMessageAt: now,
      messageCount: 1,
      createdAt: now,
      updatedAt: now
    };
    const message: EmailMessageDocument = {
      _id: new ObjectId(),
      agentId,
      threadId: thread._id,
      direction: "inbound",
      fromEmail: payload.from,
      toEmail: account.address,
      subject: payload.subject,
      textBody: payload.text,
      providerMessageId: `test-inbound-${thread._id.toHexString()}`,
      parsedBy: "heuristic",
      summary: payload.text,
      suggestedReply: "Thanks for the update. I will follow up shortly.",
      status: "received",
      createdAt: now,
      updatedAt: now
    };
    await collections.emailThreads.insertOne(thread);
    await collections.emailMessages.insertOne(message);
    emitOwnerEvent(authContext.user._id, "email.received", {
      agentId: agentId.toHexString(),
      threadId: thread._id.toHexString(),
      messageId: message._id.toHexString()
    });
    return { threadId: thread._id.toHexString(), messageId: message._id.toHexString() };
  });

  app.post("/api/test-support/post-call", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = postCallSchema.parse(request.body ?? {});
    const callId = objectId(payload.callId, "callId");
    const call = await collections.calls.findOne({ _id: callId });
    if (!call) throw new ApiError(404, "not_found", "call not found");
    const agent = await collections.agents.findOne({ _id: call.agentId, ownerUserId: authContext.user._id });
    if (!agent) throw new ApiError(404, "not_found", "call not found");
    const now = new Date();
    const transcript = [
      { role: "agent", message: "Hi, this is the agent calling with a test update.", timeInCallSecs: 1 },
      { role: "user", message: "Confirmed, this works for me.", timeInCallSecs: 12 }
    ];
    await collections.calls.updateOne(
      { _id: callId },
      {
        $set: {
          status: "completed",
          summary: payload.summary ?? "Test call completed successfully.",
          transcript,
          durationSecs: 42,
          costCents: 15,
          updatedAt: now
        }
      }
    );
    emitOwnerEvent(authContext.user._id, "call.completed", { agentId: agent._id.toHexString(), callId: callId.toHexString() });
    return { ok: true };
  });

  app.post("/api/test-support/billing-plan", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = billingPlanSchema.parse(request.body ?? {});
    const now = new Date();
    await collections.billingAccounts.updateOne(
      { ownerUserId: authContext.user._id },
      {
        $set: {
          ownerUserId: authContext.user._id,
          stripeCustomerId: "cus_e2e",
          plan: payload.plan,
          ...(payload.plan === "free" ? {} : { subscriptionStatus: "active" }),
          updatedAt: now
        },
        ...(payload.plan === "free" ? { $unset: { subscriptionStatus: "" } } : {}),
        $setOnInsert: { _id: new ObjectId(), createdAt: now }
      },
      { upsert: true }
    );
    return { ok: true };
  });
}

function objectId(value: string, label: string): ObjectId {
  if (!ObjectId.isValid(value)) throw new ApiError(400, "validation_failed", `${label} is invalid`);
  return new ObjectId(value);
}
