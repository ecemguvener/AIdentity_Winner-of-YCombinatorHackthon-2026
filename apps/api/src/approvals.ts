import { EventEmitter } from "node:events";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { ApprovalDocument, Collections } from "./db.js";
import type { AppConfig } from "./config.js";
import { authenticateAgentRequest } from "./agent-auth.js";
import { requireAuth } from "./auth.js";
import { AUDIT_ACTIONS, recordAudit } from "./audit.js";
import { ApiError } from "./errors.js";

type ApprovalDecision = "approved" | "rejected";
type WaitDecision = ApprovalDecision | "expired" | "timeout";
type ApprovalEventName = "approval.requested" | "approval.decided" | "approval.expired";
type OwnerEvent = { ownerUserId: ObjectId; name: string; payload: unknown };
type ApprovalExecutor = (approval: ApprovalDocument) => Promise<Record<string, unknown> | void>;

export interface RequestApprovalInput {
  agentId: ObjectId | string;
  ownerUserId: ObjectId | string;
  kind: ApprovalDocument["kind"];
  payloadSummary: string;
  payload: Record<string, unknown>;
  ttlMinutes?: number;
}

const decisionSchema = z.object({
  note: z.string().max(500).optional()
});

const listQuerySchema = z.object({
  status: z.enum(["pending", "all"]).optional().default("pending"),
  cursor: z.string().optional()
});

const eventsQuerySchema = z.object({
  since: z.string().datetime().optional()
});

const agentApprovalQuerySchema = z.object({
  id: z.string()
});

const bus = new EventEmitter();
bus.setMaxListeners(500);
const executors = new Map<ApprovalDocument["kind"], ApprovalExecutor>();

export function registerApprovalExecutor(kind: ApprovalDocument["kind"], executor: ApprovalExecutor): void {
  executors.set(kind, executor);
}

export async function requestApproval(
  collections: Collections,
  input: RequestApprovalInput
): Promise<ApprovalDocument> {
  const agentId = toObjectId(input.agentId, "agentId");
  const ownerUserId = toObjectId(input.ownerUserId, "ownerUserId");
  const now = new Date();
  const approval: ApprovalDocument = {
    _id: new ObjectId(),
    agentId,
    ownerUserId,
    kind: input.kind,
    status: "pending",
    payloadSummary: input.payloadSummary.trim(),
    payload: input.payload,
    expiresAt: new Date(now.getTime() + (input.ttlMinutes ?? 60) * 60_000),
    createdAt: now,
    updatedAt: now
  };
  await collections.approvals.insertOne(approval);
  await recordAudit(collections, {
    agentId,
    ownerUserId,
    actor: "agent",
    action: AUDIT_ACTIONS.approval.requested,
    status: "pending",
    detail: approval.payloadSummary,
    resourceType: "approval",
    resourceId: approval._id.toHexString(),
    metadata: { kind: approval.kind }
  });
  emitApproval("approval.requested", approval);
  return approval;
}

export async function decideApproval(
  collections: Collections,
  ownerUserId: ObjectId | string,
  approvalId: ObjectId | string,
  decision: ApprovalDecision,
  note?: string
): Promise<ApprovalDocument> {
  const now = new Date();
  const approvalObjectId = toObjectId(approvalId, "approvalId");
  const ownerObjectId = toObjectId(ownerUserId, "ownerUserId");
  const updated = await collections.approvals.findOneAndUpdate(
    { _id: approvalObjectId, ownerUserId: ownerObjectId, status: "pending" },
    {
      $set: {
        status: decision,
        ...(note?.trim() ? { decisionNote: note.trim() } : {}),
        decidedAt: now,
        updatedAt: now
      }
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    const existing = await collections.approvals.findOne({ _id: approvalObjectId, ownerUserId: ownerObjectId });
    if (!existing) {
      throw new ApiError(404, "not_found", "approval not found");
    }
    throw new ApiError(409, "validation_failed", `approval is already ${existing.status}`);
  }

  let finalApproval = updated;
  if (decision === "approved") {
    finalApproval = await executeApproval(collections, updated);
  }

  await recordAudit(collections, {
    agentId: finalApproval.agentId,
    ownerUserId: finalApproval.ownerUserId,
    actor: "owner",
    action: decision === "approved" ? AUDIT_ACTIONS.approval.approved : AUDIT_ACTIONS.approval.rejected,
    status: decision === "approved" ? "allowed" : "blocked",
    detail: `${finalApproval.payloadSummary}${note?.trim() ? ` (${note.trim()})` : ""}`,
    resourceType: "approval",
    resourceId: finalApproval._id.toHexString(),
    metadata: { kind: finalApproval.kind }
  });
  emitApproval("approval.decided", finalApproval);
  return finalApproval;
}

export async function waitForDecision(
  collections: Collections,
  approvalId: ObjectId | string,
  options: { timeoutMs: number }
): Promise<WaitDecision> {
  const approvalObjectId = toObjectId(approvalId, "approvalId");
  const immediate = await collections.approvals.findOne({ _id: approvalObjectId });
  if (!immediate) {
    return "timeout";
  }
  if (immediate.status !== "pending") {
    return immediate.status;
  }
  if (immediate.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: WaitDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(pollId);
      bus.off(eventKey(approvalObjectId), onApproval);
      resolve(decision);
    };
    const onApproval = (approval: ApprovalDocument) => {
      if (approval.status === "pending") return;
      finish(approval.status);
    };
    const timeoutId = setTimeout(() => finish("timeout"), options.timeoutMs);
    const pollId = setInterval(async () => {
      const approval = await collections.approvals.findOne({ _id: approvalObjectId });
      if (!approval) return;
      if (approval.status !== "pending") {
        finish(approval.status);
      } else if (approval.expiresAt.getTime() <= Date.now()) {
        finish("expired");
      }
    }, 5_000);
    bus.on(eventKey(approvalObjectId), onApproval);
  });
}

export function registerApprovalRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  const sweeper = setInterval(() => {
    void expirePendingApprovals(collections).catch((error) => {
      app.log.error({ error }, "approval expiry sweeper failed");
    });
  }, 60_000);
  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweeper);
    done();
  });

  app.get("/api/v1/approvals", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const query = listQuerySchema.parse(request.query ?? {});
    const filter: Record<string, unknown> = { ownerUserId: authContext.user._id };
    if (query.status === "pending") {
      filter.status = "pending";
    }
    if (query.cursor && ObjectId.isValid(query.cursor)) {
      filter._id = { $lt: new ObjectId(query.cursor) };
    }
    const approvals = await collections.approvals
      .find(filter)
      .sort({ _id: -1 })
      .limit(51)
      .toArray();
    const page = approvals.slice(0, 50);
    return {
      approvals: await serializeApprovals(collections, page),
      nextCursor: approvals.length > 50 ? page.at(-1)?._id.toHexString() ?? null : null
    };
  });

  app.post("/api/v1/approvals/:id/approve", async (request, reply) =>
    decideRoute(request, reply, "approved")
  );
  app.post("/api/v1/approvals/:id/reject", async (request, reply) =>
    decideRoute(request, reply, "rejected")
  );

  app.get("/api/v1/events", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const query = eventsQuerySchema.parse(request.query ?? {});
    const ownerUserId = authContext.user._id;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.write("retry: 3000\n\n");
    setSseConnectionDelta(1);

    if (query.since) {
      const since = new Date(query.since);
      const missed = await collections.approvals
        .find({ ownerUserId, updatedAt: { $gte: since } })
        .sort({ updatedAt: 1 })
        .toArray();
      for (const approval of missed) {
        writeSse(reply, eventNameForApproval(approval), serializeApproval(approval));
      }
    }

    const listener = (event: { name: ApprovalEventName; approval: ApprovalDocument }) => {
      if (!event.approval.ownerUserId.equals(ownerUserId)) return;
      writeSse(reply, event.name, serializeApproval(event.approval));
    };
    const ownerListener = (event: OwnerEvent) => {
      if (!event.ownerUserId.equals(ownerUserId)) return;
      writeSse(reply, event.name, event.payload);
    };
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 25_000);
    bus.on("approval-event", listener);
    bus.on("owner-event", ownerListener);
    request.raw.on("close", () => {
      setSseConnectionDelta(-1);
      clearInterval(heartbeat);
      bus.off("approval-event", listener);
      bus.off("owner-event", ownerListener);
      reply.raw.end();
    });
  });

  app.get("/api/v1/agent/approvals/:id", async (request) => {
    const agentContext = await authenticateAgentRequest(request, collections);
    if (!agentContext) {
      throw new ApiError(401, "unauthorized", "missing or invalid identity token");
    }
    const params = agentApprovalQuerySchema.parse(request.params ?? {});
    if (!ObjectId.isValid(params.id)) {
      throw new ApiError(404, "not_found", "approval not found");
    }
    const approval = await collections.approvals.findOne({
      _id: new ObjectId(params.id),
      agentId: agentContext.agent._id
    });
    if (!approval) {
      throw new ApiError(404, "not_found", "approval not found");
    }
    return { approval: serializeApproval(approval) };
  });

  async function decideRoute(request: FastifyRequest, reply: FastifyReply, decision: ApprovalDecision) {
    const authContext = await requireAuth(request, reply, collections, config);
    const params = agentApprovalQuerySchema.parse(request.params ?? {});
    const payload = decisionSchema.parse(request.body ?? {});
    const approval = await decideApproval(collections, authContext.user._id, params.id, decision, payload.note);
    return { approval: serializeApproval(approval) };
  }
}

function setSseConnectionDelta(delta: number): void {
  const globalState = globalThis as typeof globalThis & { __barkanSseConnections?: number };
  globalState.__barkanSseConnections = Math.max(0, (globalState.__barkanSseConnections ?? 0) + delta);
}

async function expirePendingApprovals(collections: Collections): Promise<number> {
  const now = new Date();
  const due = await collections.approvals.find({ status: "pending", expiresAt: { $lte: now } }).toArray();
  let expiredCount = 0;
  for (const approval of due) {
    const updated = await collections.approvals.findOneAndUpdate(
      { _id: approval._id, status: "pending" },
      { $set: { status: "expired", updatedAt: now } },
      { returnDocument: "after" }
    );
    if (!updated) continue;
    expiredCount += 1;
    await recordAudit(collections, {
      agentId: updated.agentId,
      ownerUserId: updated.ownerUserId,
      actor: "system",
      action: AUDIT_ACTIONS.approval.expired,
      status: "blocked",
      detail: updated.payloadSummary,
      resourceType: "approval",
      resourceId: updated._id.toHexString(),
      metadata: { kind: updated.kind }
    });
    emitApproval("approval.expired", updated);
  }
  return expiredCount;
}

async function executeApproval(collections: Collections, approval: ApprovalDocument): Promise<ApprovalDocument> {
  const executor = executors.get(approval.kind);
  if (!executor) {
    return approval;
  }
  try {
    const executionResult = await executor(approval);
    const updated = await collections.approvals.findOneAndUpdate(
      { _id: approval._id },
      {
        $set: {
          executionResult: executionResult ?? {},
          updatedAt: new Date()
        },
        $unset: { executionError: "" }
      },
      { returnDocument: "after" }
    );
    return updated ?? approval;
  } catch (error) {
    const updated = await collections.approvals.findOneAndUpdate(
      { _id: approval._id },
      {
        $set: {
          executionError: (error as Error).message,
          updatedAt: new Date()
        }
      },
      { returnDocument: "after" }
    );
    return updated ?? { ...approval, executionError: (error as Error).message };
  }
}

async function serializeApprovals(collections: Collections, approvals: ApprovalDocument[]) {
  const agentIds = [...new Set(approvals.map((approval) => approval.agentId.toHexString()))].map((id) => new ObjectId(id));
  const agents = await collections.agents.find({ _id: { $in: agentIds } }).project<{ _id: ObjectId; name: string }>({ name: 1 }).toArray();
  const agentNames = new Map(agents.map((agent) => [agent._id.toHexString(), agent.name]));
  return approvals.map((approval) => ({
    ...serializeApproval(approval),
    agentName: agentNames.get(approval.agentId.toHexString()) ?? "Agent"
  }));
}

function serializeApproval(approval: ApprovalDocument) {
  return {
    id: approval._id.toHexString(),
    agentId: approval.agentId.toHexString(),
    ownerUserId: approval.ownerUserId.toHexString(),
    kind: approval.kind,
    status: approval.status,
    payloadSummary: approval.payloadSummary,
    payload: approval.payload,
    decisionNote: approval.decisionNote ?? null,
    executionResult: approval.executionResult ?? null,
    executionError: approval.executionError ?? null,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    expiresAt: approval.expiresAt.toISOString(),
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString()
  };
}

function emitApproval(name: ApprovalEventName, approval: ApprovalDocument) {
  bus.emit(eventKey(approval._id), approval);
  bus.emit("approval-event", { name, approval });
}

export function emitOwnerEvent(ownerUserId: ObjectId, name: string, payload: unknown): void {
  bus.emit("owner-event", { ownerUserId, name, payload });
}

function eventKey(approvalId: ObjectId): string {
  return `approval:${approvalId.toHexString()}`;
}

function eventNameForApproval(approval: ApprovalDocument): ApprovalEventName {
  if (approval.status === "expired") return "approval.expired";
  if (approval.status === "approved" || approval.status === "rejected") return "approval.decided";
  return "approval.requested";
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function toObjectId(value: ObjectId | string, label: string): ObjectId {
  if (value instanceof ObjectId) return value;
  if (!ObjectId.isValid(value)) {
    throw new ApiError(400, "validation_failed", `${label} is invalid`);
  }
  return new ObjectId(value);
}
