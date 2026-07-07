import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections, UserDocument } from "./db.js";
import { ApiError } from "./errors.js";
import { emitOwnerEvent } from "./approvals.js";
import { requireAuth } from "./auth.js";

export type OnboardingStep = "agent_created" | "runtime_connected" | "first_email_sent" | "approval_decided" | "phone_added";

const requiredSteps: OnboardingStep[] = ["agent_created", "runtime_connected", "first_email_sent", "approval_decided"];
const dismissSchema = z.object({ dismissed: z.boolean() });

export async function completeOnboardingStep(
  collections: Collections,
  ownerUserId: ObjectId | string | null | undefined,
  step: OnboardingStep,
  metadata: Record<string, unknown> = {}
): Promise<UserDocument | null> {
  if (!ownerUserId) return null;
  const ownerObjectId = ownerUserId instanceof ObjectId ? ownerUserId : new ObjectId(ownerUserId);
  const user = await collections.users.findOne({ _id: ownerObjectId });
  if (!user) return null;
  const events = user.onboarding?.events ?? [];
  if (events.some((event) => event.step === step)) return user;

  const now = new Date();
  const nextEvents = [...events, { step, at: now, ...(Object.keys(metadata).length ? { metadata } : {}) }];
  const completedAt = requiredSteps.every((requiredStep) => nextEvents.some((event) => event.step === requiredStep))
    ? (user.onboarding?.completedAt ?? now)
    : user.onboarding?.completedAt;
  const updated = await collections.users.findOneAndUpdate(
    { _id: ownerObjectId },
    {
      $set: {
        "onboarding.events": nextEvents,
        ...(completedAt ? { "onboarding.completedAt": completedAt } : {}),
        updatedAt: now
      }
    },
    { returnDocument: "after" }
  );
  const nextUser = updated ?? await collections.users.findOne({ _id: ownerObjectId });
  if (nextUser) {
    emitOwnerEvent(ownerObjectId, "onboarding.updated", serializeOnboarding(nextUser));
  }
  return nextUser;
}

export function serializeOnboarding(user: UserDocument) {
  const events = user.onboarding?.events ?? [];
  const steps = Object.fromEntries(requiredSteps.map((step) => [
    step,
    events.find((event) => event.step === step)?.at.toISOString() ?? null
  ])) as Record<OnboardingStep, string | null>;
  return {
    dismissedAt: user.onboarding?.dismissedAt?.toISOString() ?? null,
    completedAt: user.onboarding?.completedAt?.toISOString() ?? null,
    steps,
    events: events.map((event) => ({
      step: event.step,
      at: event.at.toISOString(),
      metadata: event.metadata ?? {}
    }))
  };
}

export function registerOnboardingRoutes(app: FastifyInstance, collections: Collections, config: AppConfig): void {
  app.patch("/api/v1/onboarding", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    const payload = dismissSchema.parse(request.body ?? {});
    const now = new Date();
    const update = payload.dismissed
      ? { $set: { "onboarding.dismissedAt": now, updatedAt: now } }
      : { $unset: { "onboarding.dismissedAt": "" }, $set: { updatedAt: now } };
    await collections.users.updateOne({ _id: authContext.user._id }, update);
    const user = await collections.users.findOne({ _id: authContext.user._id });
    if (!user) throw new ApiError(404, "not_found", "user not found");
    emitOwnerEvent(user._id, "onboarding.updated", serializeOnboarding(user));
    return { onboarding: serializeOnboarding(user) };
  });

  app.get("/api/v1/ops/activation", async (request, reply) => {
    await requireAuth(request, reply, collections, config);
    const users = await collections.users.find({ "onboarding.events.0": { $exists: true } }).toArray();
    const summary = buildActivationSummary(users);
    return summary;
  });
}

function buildActivationSummary(users: UserDocument[]) {
  const counts = Object.fromEntries(requiredSteps.map((step) => [step, 0])) as Record<OnboardingStep, number>;
  const firstActionDurations: number[] = [];
  for (const user of users) {
    const events = user.onboarding?.events ?? [];
    for (const step of requiredSteps) {
      if (events.some((event) => event.step === step)) counts[step] += 1;
    }
    const firstEmail = events.find((event) => event.step === "first_email_sent");
    if (firstEmail) {
      firstActionDurations.push(firstEmail.at.getTime() - user.createdAt.getTime());
    }
  }
  return {
    usersStarted: users.length,
    stepCounts: counts,
    medianTimeToFirstActionMs: median(firstActionDurations)
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
