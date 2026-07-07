import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections, UserDocument } from "./db.js";
import { ensureBillingAccount } from "./billing.js";
import { ApiError } from "./errors.js";
import { serializeOnboarding } from "./onboarding.js";
import { deletedEmailHash, deletedEmailHoldExpiresAt } from "./privacy.js";
import {
  createSessionExpiry,
  createSessionIdleExpiry,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  isPasswordUsable,
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  verifyPassword
} from "./security.js";

export interface AuthContext {
  user: UserDocument;
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128)
});

const emailLookupSchema = z.object({
  email: z.string().email()
});

const avatarDataUrlSchema = z.string().trim().max(400_000).refine(
  (value) => /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value),
  "profile picture must be a PNG, JPEG, WebP, or GIF data URL"
);

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  email: z.string().email().optional(),
  avatarUrl: avatarDataUrlSchema.nullable().optional()
}).refine((payload) => payload.displayName !== undefined || payload.email !== undefined || payload.avatarUrl !== undefined, {
  message: "at least one profile field is required"
});

const notificationPreferencesSchema = z.object({
  productEmails: z.boolean(),
  identityEmails: z.boolean(),
  securityEmails: z.boolean()
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(128)
});

const loginWindowMs = 15 * 60 * 1000;
const lockoutThreshold = 10;

export function registerAuthRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig
) {
  app.post("/api/auth/check-email", async (request) => {
    const payload = emailLookupSchema.parse(request.body);
    const email = normalizeEmail(payload.email);
    const existingUser = await collections.users.findOne({
      $or: [
        { email },
        { emailHash: deletedEmailHash(email, config), deletedAt: { $gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }
      ]
    }, { projection: { _id: 1 } });

    return { exists: Boolean(existingUser) };
  });

  app.post("/api/auth/signup", async (request, reply) => {
    const credentials = credentialsSchema.parse(request.body);
    const email = normalizeEmail(credentials.email);

    if (!isPasswordUsable(credentials.password)) {
      throw new ApiError(400, "validation_failed", `password must be between ${PASSWORD_MIN_LENGTH} and 128 characters`);
    }

    const existingUser = await collections.users.findOne({ email });
    if (existingUser) {
      throw new ApiError(409, "validation_failed", "email is already registered");
    }
    const tombstone = await collections.users.findOne({ emailHash: deletedEmailHash(email, config), deletedAt: { $exists: true } });
    if (tombstone?.deletedAt && deletedEmailHoldExpiresAt(tombstone.deletedAt).getTime() > Date.now()) {
      throw new ApiError(409, "validation_failed", "email is temporarily unavailable after account deletion");
    }

    const now = new Date();
    const insertResult = await collections.users.insertOne({
      _id: new ObjectId(),
      email,
      passwordHash: await hashPassword(credentials.password),
      createdAt: now
    });

    const user = await collections.users.findOne({ _id: insertResult.insertedId });
    if (!user) {
      throw new ApiError(500, "internal", "internal server error");
    }

    await ensureBillingAccount(collections, config, user);
    await createSession(reply, collections, config, user._id);
    return { user: serializeUser(user) };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const credentials = credentialsSchema.parse(request.body);
    const email = normalizeEmail(credentials.email);
    const user = await collections.users.findOne({ email });

    if (user?.loginLockedUntil && user.loginLockedUntil.getTime() > Date.now()) {
      throw new ApiError(423, "validation_failed", "account is temporarily locked; use password reset or wait before trying again", {
        lockedUntil: user.loginLockedUntil.toISOString()
      });
    }

    if (!user || !(await verifyPassword(credentials.password, user.passwordHash))) {
      if (user) {
        await registerFailedLogin(collections, user);
      }
      throw new ApiError(401, "unauthorized", "invalid email or password");
    }

    await Promise.all([
      collections.sessions.deleteMany({ userId: user._id }),
      collections.users.updateOne(
        { _id: user._id },
        { $unset: { loginFailedCount: "", loginFirstFailedAt: "", loginLockedUntil: "" }, $set: { updatedAt: new Date() } }
      )
    ]);
    await createSession(reply, collections, config, user._id);
    return { user: serializeUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const tokens = extractSessionTokens(request, getAcceptedSessionCookieNames(config));
    if (tokens.length > 0) {
      const tokenHashes = tokens.map((token) => hashSessionToken(token, config.SESSION_SECRET));
      const matchingSessions = await collections.sessions
        .find({ tokenHash: { $in: tokenHashes } })
        .project<{ userId: ObjectId }>({ userId: 1 })
        .toArray();
      const userIds = matchingSessions.map((session) => session.userId);

      await collections.sessions.deleteMany({
        $or: [
          { tokenHash: { $in: tokenHashes } },
          ...(userIds.length > 0 ? [{ userId: { $in: userIds } }] : [])
        ]
      });
    }

    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    return { user: serializeUser(authContext.user) };
  });

  app.patch("/api/auth/me", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const payload = updateProfileSchema.parse(request.body);
    const updates: Partial<UserDocument> = {
      updatedAt: new Date()
    };

    if (payload.displayName !== undefined) {
      updates.displayName = payload.displayName;
    }

    if (payload.email !== undefined) {
      const email = normalizeEmail(payload.email);
      if (email !== authContext.user.email) {
        const existingUser = await collections.users.findOne({ email }, { projection: { _id: 1 } });
        if (existingUser && !existingUser._id.equals(authContext.user._id)) {
          throw new ApiError(409, "validation_failed", "email is already registered");
        }
      }
      updates.email = email;
    }

    if (payload.avatarUrl !== undefined) {
      updates.avatarUrl = payload.avatarUrl;
    }

    const updateResult = await collections.users.findOneAndUpdate(
      { _id: authContext.user._id },
      { $set: updates },
      { returnDocument: "after" }
    );
    const updatedUser = updateResult ?? await collections.users.findOne({ _id: authContext.user._id });
    if (!updatedUser) {
      throw new ApiError(404, "not_found", "user not found");
    }

    return { user: serializeUser(updatedUser) };
  });

  app.patch("/api/auth/me/notifications", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const notificationPreferences = notificationPreferencesSchema.parse(request.body);
    const updateResult = await collections.users.findOneAndUpdate(
      { _id: authContext.user._id },
      {
        $set: {
          notificationPreferences,
          updatedAt: new Date()
        }
      },
      { returnDocument: "after" }
    );
    const updatedUser = updateResult ?? await collections.users.findOne({ _id: authContext.user._id });
    if (!updatedUser) {
      throw new ApiError(404, "not_found", "user not found");
    }

    return { user: serializeUser(updatedUser) };
  });

  app.post("/api/auth/me/password", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const payload = updatePasswordSchema.parse(request.body);
    if (!(await verifyPassword(payload.currentPassword, authContext.user.passwordHash))) {
      throw new ApiError(400, "validation_failed", "current password is incorrect");
    }

    if (!isPasswordUsable(payload.newPassword)) {
      throw new ApiError(400, "validation_failed", `password must be between ${PASSWORD_MIN_LENGTH} and 128 characters`);
    }

    await collections.users.updateOne(
      { _id: authContext.user._id },
      {
        $set: {
          passwordHash: await hashPassword(payload.newPassword),
          updatedAt: new Date()
        }
      }
    );

    return { ok: true };
  });
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  collections: Collections,
  config: AppConfig
): Promise<AuthContext> {
  const token = getAcceptedSessionCookieNames(config)
    .map((cookieName) => request.cookies[cookieName])
    .find((cookieValue): cookieValue is string => Boolean(cookieValue));
  if (!token) {
    throw new ApiError(401, "unauthorized", "authentication required");
  }

  const session = await collections.sessions.findOne({
    tokenHash: hashSessionToken(token, config.SESSION_SECRET),
    expiresAt: { $gt: new Date() },
    $or: [{ idleExpiresAt: { $exists: false } }, { idleExpiresAt: { $gt: new Date() } }]
  });

  if (!session) {
    clearSessionCookie(reply, config);
    throw new ApiError(401, "unauthorized", "authentication required");
  }

  const user = await collections.users.findOne({ _id: session.userId });
  if (!user) {
    throw new ApiError(401, "unauthorized", "authentication required");
  }
  (request as FastifyRequest & { authUserId?: ObjectId }).authUserId = user._id;

  const idleExpiresAt = createSessionIdleExpiry();
  await collections.sessions.updateOne(
    { _id: session._id },
    { $set: { lastSeenAt: new Date(), idleExpiresAt: idleExpiresAt < session.expiresAt ? idleExpiresAt : session.expiresAt } }
  );

  return { user };
}

async function registerFailedLogin(collections: Collections, user: UserDocument): Promise<void> {
  const now = new Date();
  const firstFailedAt = user.loginFirstFailedAt && now.getTime() - user.loginFirstFailedAt.getTime() <= loginWindowMs
    ? user.loginFirstFailedAt
    : now;
  const failedCount = firstFailedAt === user.loginFirstFailedAt ? (user.loginFailedCount ?? 0) + 1 : 1;
  await collections.users.updateOne(
    { _id: user._id },
    {
      $set: {
        loginFailedCount: failedCount,
        loginFirstFailedAt: firstFailedAt,
        ...(failedCount >= lockoutThreshold ? { loginLockedUntil: new Date(now.getTime() + loginWindowMs) } : {}),
        updatedAt: now
      }
    }
  );
}

async function createSession(
  reply: FastifyReply,
  collections: Collections,
  config: AppConfig,
  userId: ObjectId
) {
  const token = createSessionToken();
  await collections.sessions.insertOne({
    _id: new ObjectId(),
    userId,
    tokenHash: hashSessionToken(token, config.SESSION_SECRET),
    expiresAt: createSessionExpiry(),
    idleExpiresAt: createSessionIdleExpiry(),
    lastSeenAt: new Date(),
    createdAt: new Date()
  });

  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30
  });
}

function clearSessionCookie(reply: FastifyReply, config: AppConfig) {
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.NODE_ENV === "production"
  };

  reply.clearCookie(config.SESSION_COOKIE_NAME, cookieOptions);
  reply.setCookie(config.SESSION_COOKIE_NAME, "", {
    ...cookieOptions,
    maxAge: 0,
    expires: new Date(0)
  });

}

function getAcceptedSessionCookieNames(config: AppConfig): string[] {
  return [config.SESSION_COOKIE_NAME];
}

function extractSessionTokens(request: FastifyRequest, cookieNames: string[]): string[] {
  const tokens = new Set<string>();
  const acceptedCookieNames = new Set(cookieNames);

  for (const cookieName of acceptedCookieNames) {
    const parsedCookieToken = request.cookies[cookieName];
    if (parsedCookieToken) {
      tokens.add(parsedCookieToken);
    }
  }

  const rawCookieHeader = request.headers.cookie;
  if (typeof rawCookieHeader !== "string") {
    return [...tokens];
  }

  for (const cookiePart of rawCookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = cookiePart.split("=");
    if (!acceptedCookieNames.has(rawName?.trim() ?? "")) {
      continue;
    }

    const rawValue = rawValueParts.join("=").trim();
    if (rawValue) {
      tokens.add(decodeURIComponent(rawValue));
    }
  }

  return [...tokens];
}

function serializeUser(user: UserDocument) {
  return {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    notificationPreferences: {
      productEmails: user.notificationPreferences?.productEmails ?? true,
      identityEmails: user.notificationPreferences?.identityEmails ?? true,
      securityEmails: user.notificationPreferences?.securityEmails ?? true
    },
    onboarding: serializeOnboarding(user),
    createdAt: user.createdAt.toISOString()
  };
}
