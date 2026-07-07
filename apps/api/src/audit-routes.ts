import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AuditLogDocument, Collections } from "./db.js";
import { requireAuth } from "./auth.js";
import {
  auditCsvHeader,
  auditEntryToCsvRow,
  buildAuditFilter,
  listAuditEntries,
  serializeAuditEntry
} from "./audit.js";

const statusSchema = z.enum(["allowed", "blocked", "pending", "error"]);
const objectIdStringSchema = z.string().refine((value) => ObjectId.isValid(value), "invalid ObjectId");
const dateStringSchema = z.string().transform((value, context) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid date" });
    return z.NEVER;
  }
  return date;
});

const auditQuerySchema = z.object({
  agentId: objectIdStringSchema.optional(),
  action: z.string().min(1).max(120).optional(),
  status: statusSchema.optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  cursor: objectIdStringSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export function registerAuditRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  app.get("/api/v1/audit", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const query = auditQuerySchema.parse(request.query ?? {});
    const { entries, nextCursor } = await listAuditEntries(collections, {
      ...query,
      ownerUserId: authContext.user._id
    });

    return {
      entries: entries.map(serializeAuditEntry),
      next_cursor: nextCursor
    };
  });

  app.get("/api/v1/audit/export.csv", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const query = auditQuerySchema.parse(request.query ?? {});
    const filter = buildAuditFilter({ ...query, ownerUserId: authContext.user._id });
    const cursor = collections.auditLogs
      .find(filter)
      .sort({ _id: -1 })
      .batchSize(500);

    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"barkan-audit.csv\"");
    return reply.send(Readable.from(csvRows(cursor)));
  });
}

async function* csvRows(cursor: AsyncIterable<AuditLogDocument>): AsyncGenerator<string> {
  yield auditCsvHeader();
  for await (const entry of cursor) {
    yield auditEntryToCsvRow(entry);
  }
}
