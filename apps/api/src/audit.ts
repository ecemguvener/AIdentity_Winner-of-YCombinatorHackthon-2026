import { ObjectId, type Filter } from "mongodb";
import type { AuditLogDocument, Collections } from "./db.js";

export const AUDIT_ACTIONS = {
  identity: {
    init: "identity.init",
    revoke: "identity.revoke",
    tokenRotate: "identity.token.rotate"
  },
  email: {
    send: "email.send",
    receive: "email.receive",
    blocked: "email.blocked",
    provision: "email.provision",
    pause: "email.pause",
    resume: "email.resume"
  },
  phone: {
    outbound: "phone.call.outbound",
    inbound: "phone.call.inbound"
  },
  sms: {
    send: "sms.send",
    receive: "sms.receive"
  },
  approval: {
    requested: "approval.requested",
    approved: "approval.approved",
    rejected: "approval.rejected",
    expired: "approval.expired"
  },
  policy: {
    updated: "policy.updated"
  },
  billing: {
    provision: "billing.provision",
    request: "billing.request",
    approved: "billing.approved",
    rejected: "billing.rejected",
    execute: "billing.execute"
  }
} as const;

export interface AuditEntryInput {
  agentId: ObjectId | string;
  ownerUserId?: ObjectId | string | null;
  actor: AuditLogDocument["actor"];
  action: string;
  status: AuditLogDocument["status"];
  detail: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditFilterInput {
  ownerUserId?: ObjectId | string;
  agentId?: ObjectId | string;
  action?: string;
  status?: AuditLogDocument["status"];
  from?: Date;
  to?: Date;
  cursor?: ObjectId | string;
}

export interface AuditPageOptions extends AuditFilterInput {
  limit?: number;
}

export async function recordAudit(
  collections: Pick<Collections, "auditLogs">,
  entry: AuditEntryInput
): Promise<string | null> {
  try {
    const agentId = toObjectId(entry.agentId);
    if (!agentId) {
      throw new Error(`invalid audit agentId: ${String(entry.agentId)}`);
    }

    const ownerUserId = entry.ownerUserId === undefined || entry.ownerUserId === null
      ? null
      : toObjectId(entry.ownerUserId);
    if (entry.ownerUserId !== undefined && entry.ownerUserId !== null && !ownerUserId) {
      throw new Error(`invalid audit ownerUserId: ${String(entry.ownerUserId)}`);
    }

    const now = new Date();
    const document: AuditLogDocument = {
      _id: new ObjectId(),
      agentId,
      ownerUserId,
      actor: entry.actor,
      action: entry.action,
      status: entry.status,
      detail: entry.detail,
      ...(entry.resourceType ? { resourceType: entry.resourceType } : {}),
      ...(entry.resourceId ? { resourceId: entry.resourceId } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      createdAt: now
    };

    const result = await collections.auditLogs.insertOne(document);
    return result.insertedId.toHexString();
  } catch (error) {
    console.error("audit insert failed", error);
    return null;
  }
}

export async function recordAuditForAgentHexId(
  collections: Pick<Collections, "agents" | "auditLogs">,
  agentIdHex: string,
  entry: Omit<AuditEntryInput, "agentId" | "ownerUserId">
): Promise<string | null> {
  try {
    if (!ObjectId.isValid(agentIdHex)) {
      return null;
    }
    const agentId = new ObjectId(agentIdHex);
    const agent = await collections.agents.findOne({ _id: agentId }, { projection: { ownerUserId: 1 } });
    if (!agent) {
      return null;
    }
    return recordAudit(collections, {
      agentId,
      ownerUserId: agent.ownerUserId,
      ...entry
    });
  } catch (error) {
    console.error("audit insert failed", error);
    return null;
  }
}

export function buildAuditFilter(input: AuditFilterInput): Filter<AuditLogDocument> {
  const filter: Filter<AuditLogDocument> = {};
  const ownerUserId = input.ownerUserId ? toObjectId(input.ownerUserId) : null;
  if (ownerUserId) {
    filter.ownerUserId = ownerUserId;
  }

  const agentId = input.agentId ? toObjectId(input.agentId) : null;
  if (agentId) {
    filter.agentId = agentId;
  }

  if (input.action) {
    filter.action = input.action.endsWith(".")
      ? { $regex: `^${escapeRegExp(input.action)}` }
      : input.action;
  }

  if (input.status) {
    filter.status = input.status;
  }

  if (input.from || input.to) {
    filter.createdAt = {
      ...(input.from ? { $gte: input.from } : {}),
      ...(input.to ? { $lte: input.to } : {})
    };
  }

  const cursor = input.cursor ? toObjectId(input.cursor) : null;
  if (cursor) {
    filter._id = { $lt: cursor };
  }

  return filter;
}

export async function listAuditEntries(
  collections: Pick<Collections, "auditLogs">,
  options: AuditPageOptions
): Promise<{ entries: AuditLogDocument[]; nextCursor: string | null }> {
  const limit = clampLimit(options.limit);
  const entries = await collections.auditLogs
    .find(buildAuditFilter(options))
    .sort({ _id: -1 })
    .limit(limit + 1)
    .toArray();
  const page = entries.slice(0, limit);
  const nextCursor = entries.length > limit ? page.at(-1)?._id.toHexString() ?? null : null;
  return { entries: page, nextCursor };
}

export function serializeAuditEntry(entry: AuditLogDocument) {
  return {
    id: entry._id.toHexString(),
    agent_id: entry.agentId.toHexString(),
    owner_user_id: entry.ownerUserId?.toHexString() ?? null,
    actor: entry.actor,
    action: entry.action,
    status: entry.status,
    detail: entry.detail,
    resource_type: entry.resourceType ?? null,
    resource_id: entry.resourceId ?? null,
    metadata: entry.metadata ?? null,
    created_at: entry.createdAt.toISOString()
  };
}

export function auditCsvHeader(): string {
  return "id,agent_id,owner_user_id,actor,action,status,detail,resource_type,resource_id,metadata,created_at\n";
}

export function auditEntryToCsvRow(entry: AuditLogDocument): string {
  const serialized = serializeAuditEntry(entry);
  return [
    serialized.id,
    serialized.agent_id,
    serialized.owner_user_id ?? "",
    serialized.actor,
    serialized.action,
    serialized.status,
    serialized.detail,
    serialized.resource_type ?? "",
    serialized.resource_id ?? "",
    serialized.metadata ? JSON.stringify(serialized.metadata) : "",
    serialized.created_at
  ].map(escapeCsvField).join(",") + "\n";
}

export function toObjectId(value: ObjectId | string): ObjectId | null {
  if (value instanceof ObjectId) {
    return value;
  }
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit) {
    return 50;
  }
  return Math.min(Math.max(limit, 1), 200);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}
