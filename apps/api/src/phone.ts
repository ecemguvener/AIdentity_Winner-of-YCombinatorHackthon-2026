import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AgentDocument, ApprovalDocument, Collections, SmsMessageDocument } from "./db.js";
import { requireAuth } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  getAgentPhoneCall,
  listAgentPhoneCalls,
  placeOutboundCall,
  serializePhoneCall
} from "./phone-service.js";
import {
  listAgentSmsConversation,
  sendAgentSmsWithPolicy,
  serializeSmsMessage
} from "./sms-service.js";
import { getPhonePolicy } from "./policies.js";

const callSchema = z.object({
  to: z.string().min(3).max(40),
  task: z.string().min(1).max(5000),
  context: z.string().max(8000).optional(),
  recipientName: z.string().max(200).optional()
});

const smsSchema = z.object({
  to: z.string().min(3).max(40),
  body: z.string().min(1).max(1600),
  idempotencyKey: z.string().min(1).max(120).optional()
});

const cursorQuerySchema = z.object({
  cursor: z.string().optional()
});

const smsQuerySchema = z.object({
  with: z.string().min(3).max(40).optional(),
  cursor: z.string().optional()
});

const approvalQuerySchema = z.object({
  wait: z.coerce.number().int().min(1).max(300).optional(),
  mode: z.enum(["async"]).optional()
});

export function registerPhoneRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  app.get("/api/v1/agents/:agentId/phone", async (request, reply) => {
    const agent = await loadOwnedPhoneAgent(request, reply, collections, config);
    const [number, policy] = await Promise.all([
      collections.phoneNumbers.findOne({ agentId: agent._id, status: { $in: ["provisioning", "active", "releasing"] } }, { sort: { createdAt: -1 } }),
      getPhonePolicy(collections, agent)
    ]);
    return {
      phone: {
        number: number ? {
          id: number._id.toHexString(),
          e164: number.e164,
          country: number.country,
          status: number.status,
          capabilities: { voice: number.capabilitiesVoice, sms: number.capabilitiesSms },
          created_at: number.createdAt.toISOString()
        } : null,
        capability_enabled: agent.capabilities.phone
      },
      policy
    };
  });

  app.get("/api/v1/agents/:agentId/phone/calls", async (request, reply) => {
    const agent = await loadOwnedPhoneAgent(request, reply, collections, config);
    const query = cursorQuerySchema.parse(request.query ?? {});
    const page = await listAgentPhoneCalls(collections, agent, query.cursor);
    return { calls: page.calls.map(serializePhoneCall), next_cursor: page.nextCursor };
  });

  app.get("/api/v1/agents/:agentId/phone/calls/:callId", async (request, reply) => {
    const agent = await loadOwnedPhoneAgent(request, reply, collections, config);
    const { callId } = request.params as { callId: string };
    return { call: serializePhoneCall(await getAgentPhoneCall(collections, agent, callId)) };
  });

  app.post("/api/v1/agents/:agentId/phone/call", async (request, reply) => {
    const agent = await loadOwnedPhoneAgent(request, reply, collections, config);
    const payload = callSchema.parse(request.body ?? {});
    const query = approvalQuerySchema.parse(request.query ?? {});
    const result = await placeOutboundCall(collections, config, {
      agent,
      actor: "owner",
      toNumber: payload.to,
      task: payload.task,
      context: payload.context,
      recipientName: payload.recipientName
    }, { async: query.mode === "async", waitMs: query.wait ? query.wait * 1000 : undefined });
    if ("approvalRequired" in result) {
      return reply.code(202).send(serializeApprovalPending(result.approval, result.decision));
    }
    return { ok: true, call_id: result.callId, status: result.status, from: result.from, to: result.to, simulated: result.simulated };
  });

  app.get("/api/v1/agents/:agentId/phone/sms", async (request, reply) => {
    const agent = await loadOwnedPhoneAgent(request, reply, collections, config);
    const query = smsQuerySchema.parse(request.query ?? {});
    if (query.with) {
      const page = await listAgentSmsConversation(collections, agent, { with: query.with, cursor: query.cursor });
      return { messages: page.messages.map(serializeSmsMessage), next_cursor: page.nextCursor };
    }
    return { conversations: await listSmsConversations(collections, agent), next_cursor: null };
  });

  app.post("/api/v1/agents/:agentId/phone/sms", async (request, reply) => {
    const agent = await loadOwnedPhoneAgent(request, reply, collections, config);
    const payload = smsSchema.parse(request.body ?? {});
    const query = approvalQuerySchema.parse(request.query ?? {});
    const result = await sendAgentSmsWithPolicy(collections, config, {
      agent,
      actor: "owner",
      to: payload.to,
      body: payload.body,
      idempotencyKey: payload.idempotencyKey
    }, { async: query.mode === "async", waitMs: query.wait ? query.wait * 1000 : undefined });
    if ("approvalRequired" in result) {
      return reply.code(202).send(serializeApprovalPending(result.approval, result.decision));
    }
    return { message: serializeSmsMessage(result) };
  });
}

async function loadOwnedPhoneAgent(
  request: FastifyRequest,
  reply: FastifyReply,
  collections: Collections,
  config: AppConfig
): Promise<AgentDocument> {
  const authContext = await requireAuth(request, reply, collections, config);
  const { agentId } = request.params as { agentId: string };
  if (!ObjectId.isValid(agentId)) throw new ApiError(404, "not_found", "agent identity not found");
  const agent = await collections.agents.findOne({
    _id: new ObjectId(agentId),
    ownerUserId: authContext.user._id,
    status: { $ne: "revoked" }
  });
  if (!agent) throw new ApiError(404, "not_found", "agent identity not found");
  return agent;
}

async function listSmsConversations(collections: Collections, agent: AgentDocument) {
  const newestMessages = await collections.smsMessages.aggregate<SmsMessageDocument>([
    { $match: { agentId: agent._id } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $group: { _id: "$counterpartyE164", message: { $first: "$$ROOT" }, count: { $sum: 1 } } },
    { $replaceRoot: { newRoot: { $mergeObjects: ["$message", { messageCount: "$count" }] } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: 50 }
  ]).toArray();
  return newestMessages.map((message) => ({
    counterparty_e164: message.counterpartyE164,
    last_message: serializeSmsMessage(message),
    message_count: Number((message as SmsMessageDocument & { messageCount?: number }).messageCount ?? 1)
  }));
}

function serializeApprovalPending(approval: ApprovalDocument, decision: "pending" | "timeout" | "expired") {
  return {
    ok: false,
    status: "approval_required",
    decision,
    approval_id: approval._id.toHexString(),
    approval: {
      id: approval._id.toHexString(),
      status: approval.status,
      payloadSummary: approval.payloadSummary,
      executionResult: approval.executionResult ?? null,
      executionError: approval.executionError ?? null
    }
  };
}
