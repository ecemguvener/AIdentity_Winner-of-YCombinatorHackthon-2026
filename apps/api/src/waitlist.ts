import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Collections } from "./db.js";
import { ApiError } from "./errors.js";
import { normalizeEmail } from "./security.js";

const waitlistSchema = z.object({
  email: z.string().email(),
  feature: z.literal("card")
});

export function registerWaitlistRoutes(app: FastifyInstance, collections: Collections): void {
  app.post("/api/v1/waitlist", async (request, reply) => {
    const payload = waitlistSchema.parse(request.body ?? {});
    const ip = request.ip;
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await collections.waitlist.countDocuments({ ip, createdAt: { $gte: since } });
    if (recent >= 5) {
      throw new ApiError(429, "rate_limited", "waitlist signup limit reached");
    }

    const now = new Date();
    await collections.waitlist.updateOne(
      { email: normalizeEmail(payload.email), feature: payload.feature },
      {
        $set: { ip, updatedAt: now },
        $setOnInsert: {
          _id: new ObjectId(),
          email: normalizeEmail(payload.email),
          feature: payload.feature,
          createdAt: now
        }
      },
      { upsert: true }
    );
    return reply.code(202).send({ ok: true });
  });
}
