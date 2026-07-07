import { MongoClient, type Collection, type Db, type Document, ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";

export interface UserDocument extends Document {
  _id: ObjectId;
  email: string;
  emailHash?: string;
  displayName?: string;
  avatarUrl?: string | null;
  notificationPreferences?: {
    productEmails: boolean;
    identityEmails?: boolean;
    securityEmails: boolean;
  };
  passwordHash: string;
  loginFailedCount?: number;
  loginFirstFailedAt?: Date;
  loginLockedUntil?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface SessionDocument extends Document {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  idleExpiresAt?: Date;
  lastSeenAt?: Date;
  createdAt: Date;
}

export interface SiteDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  name: string;
  domain: string;
  publicSiteKey: string;
  previewImage?: string;
  chatTheme?: "system" | "light" | "dark";
  interactionEngine?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyDocument extends Document {
  _id: ObjectId;
  userId: ObjectId;
  siteId?: ObjectId;
  projectId?: string;
  keyHash: string;
  prefix: string;
  name: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface AtlasProjectDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  siteId?: ObjectId;
  projectId: string;
  name: string;
  pendingSiteDomain?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InteractionLogDocument extends Document {
  _id: ObjectId;
  siteId: ObjectId;
  origin: string | null;
  status: "ok" | "error";
  durationMs?: number;
  error?: string;
  createdAt: Date;
}

// Agent identity provisioned by an owner user (null until claimed — see task 047 linking flow).
export interface AgentDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId | null;
  name: string;
  slug: string;
  status: "provisioning" | "active" | "paused" | "revoked";
  description?: string;
  runtime?: "openclaw" | "hermes" | "api" | "other";
  // Card capability deferred ("coming soon").
  capabilities: {
    email: boolean;
    phone: boolean;
  };
  approvalMode: "always" | "policy" | "autonomous";
  // Set by the sites/atlasProjects migration (task 005) to link back to legacy rows.
  legacySiteId?: ObjectId;
  legacyProjectId?: string;
  // OpenClaw endpoint captured by the legacy site-setup flow; kept only for
  // the /api/sites* adapter responses until the web UI migrates (task 012).
  legacyDomain?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Hashed bearer tokens an agent uses to authenticate against identity endpoints.
export interface IdentityTokenDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  ownerUserId: ObjectId | null;
  tokenHash: string;
  prefix: string;
  name: string;
  status: "active" | "revoked";
  lastUsedAt?: Date;
  lastUsedIp?: string;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Append-only audit trail of every agent/owner/system action.
export interface AuditLogDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  ownerUserId: ObjectId | null;
  actor: "agent" | "owner" | "system";
  action: string;
  status: "allowed" | "blocked" | "pending" | "error";
  detail: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// Owner approval requests for gated agent actions (expired by a periodic job, never TTL-deleted).
export interface ApprovalDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  ownerUserId: ObjectId;
  kind: "email.send" | "phone.call" | "sms.send";
  status: "pending" | "approved" | "rejected" | "expired";
  payloadSummary: string;
  payload: Record<string, unknown>;
  decisionNote?: string;
  executionResult?: Record<string, unknown>;
  executionError?: string;
  decidedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Email address provisioned for an agent.
export interface EmailAccountDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  address: string;
  displayName: string;
  status: "active" | "paused";
  createdAt: Date;
  updatedAt: Date;
}

// Conversation thread between an agent and a counterparty email address.
export interface EmailThreadDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  subject: string;
  counterpartyEmail: string;
  lastMessageAt: Date;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Individual inbound/outbound email message within a thread.
export interface EmailMessageDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  threadId: ObjectId;
  direction: "inbound" | "outbound";
  fromEmail: string;
  toEmail: string;
  cc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  providerMessageId?: string;
  idempotencyKey?: string;
  parsedBy?: "openai" | "heuristic" | null;
  providerError?: string;
  headers?: Record<string, string>;
  summary?: string;
  suggestedReply?: string;
  readAt?: Date;
  status: "queued" | "sent" | "delivered" | "bounced" | "received" | "failed";
  attachments?: Array<{
    filename: string;
    contentType: string;
    sizeBytes: number;
    providerAttachmentId?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

// Phone number provisioned for an agent via Twilio/ElevenLabs.
export interface PhoneNumberDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  e164: string;
  country: string;
  twilioSid?: string;
  elevenLabsPhoneNumberId?: string;
  capabilitiesVoice: boolean;
  capabilitiesSms: boolean;
  status: "provisioning" | "active" | "releasing" | "released";
  monthlyPriceCents?: number;
  provisioningDetail?: string;
  releaseDetail?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Voice call placed or received by an agent phone number.
export interface CallDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  phoneNumberId: ObjectId;
  direction: "inbound" | "outbound";
  counterpartyE164: string;
  task?: string;
  status: "queued" | "ringing" | "in_progress" | "completed" | "failed" | "no_answer";
  providerCallId?: string;
  elevenLabsConversationId?: string;
  durationSecs?: number;
  transcript?: Array<{
    role: string;
    message: string;
    timeInCallSecs: number;
  }>;
  summary?: string;
  costCents?: number;
  createdAt: Date;
  updatedAt: Date;
}

// SMS message sent or received by an agent phone number.
export interface SmsMessageDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  phoneNumberId: ObjectId;
  direction: "inbound" | "outbound";
  counterpartyE164: string;
  body: string;
  twilioMessageSid?: string;
  idempotencyKey?: string;
  status: "queued" | "sent" | "delivered" | "received" | "failed" | "undelivered";
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailPolicy {
  requireApproval: "always" | "new_recipients" | "never";
  allowedRecipients: string[];
  blockedRecipients: string[];
  dailySendLimit: number;
  maxRecipientsPerMessage: number;
}

export interface PhonePolicy {
  requireApprovalOutboundCall: "always" | "new_recipients" | "never";
  requireApprovalSms: "always" | "new_recipients" | "never";
  allowedCountries: string[];
  inboundEnabled: boolean;
  blockedCallers: string[];
  inboundInstructions: string;
  dailyCallLimit: number;
  dailySmsLimit: number;
  quietHours: { start: string; end: string; timezone: string } | null;
  storeTranscripts: boolean;
}

// Per-agent policy configuration.
export interface PolicyDocument extends Document {
  _id: ObjectId;
  agentId: ObjectId;
  email: EmailPolicy;
  phone: PhonePolicy | Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Inbound provider webhook events, deduplicated per provider.
export interface WebhookEventDocument extends Document {
  _id: ObjectId;
  provider: "stripe" | "twilio" | "resend" | "elevenlabs";
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  status: "received" | "processed" | "failed" | "skipped";
  error?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Stripe billing account for an owner user.
export interface BillingAccountDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  stripeCustomerId: string;
  plan: "free" | "pro" | "scale";
  subscriptionId?: string;
  subscriptionStatus?: string;
  currentPeriodEnd?: Date;
  lastStripeEventCreated?: number;
  createdAt: Date;
  updatedAt: Date;
}

// Completed migration runs recorded by the migration runner.
export interface MigrationDocument extends Document {
  _id: ObjectId;
  name: string;
  ranAt: Date;
  stats: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

// Metered usage events reported to Stripe for billing.
export interface UsageEventDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  agentId: ObjectId;
  meter: "call_minutes" | "sms_messages" | "emails_sent" | "active_numbers";
  quantity: number;
  stripeReported: boolean;
  periodKey: string;
  dedupeKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageReportDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  billingAccountId: ObjectId;
  stripeCustomerId: string;
  meter: UsageEventDocument["meter"];
  periodKey: string;
  reportedQuantity: number;
  sequence: number;
  lastIdentifier?: string;
  updatedAt: Date;
  createdAt: Date;
}

export interface PairingRequestDocument extends Document {
  _id: ObjectId;
  code: string;
  status: "pending" | "confirmed" | "claimed" | "expired";
  ownerUserId?: ObjectId;
  agentId?: ObjectId;
  identityTokenPlaintext?: string;
  tokenIssuedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpsStatusDocument extends Document {
  _id: ObjectId;
  key: string;
  kind: "backup" | "retention" | "account_deletion" | "account_export" | "alert";
  status: "ok" | "pending" | "error";
  message?: string;
  data?: Record<string, unknown>;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountExportDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  status: "pending" | "ready" | "failed" | "downloaded" | "expired";
  tokenHash: string;
  downloadPath?: string;
  error?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  downloadedAt?: Date;
}

export interface Collections {
  users: Collection<UserDocument>;
  sessions: Collection<SessionDocument>;
  sites: Collection<SiteDocument>;
  apiKeys: Collection<ApiKeyDocument>;
  atlasProjects: Collection<AtlasProjectDocument>;
  interactionLogs: Collection<InteractionLogDocument>;
  agents: Collection<AgentDocument>;
  identityTokens: Collection<IdentityTokenDocument>;
  auditLogs: Collection<AuditLogDocument>;
  approvals: Collection<ApprovalDocument>;
  emailAccounts: Collection<EmailAccountDocument>;
  emailThreads: Collection<EmailThreadDocument>;
  emailMessages: Collection<EmailMessageDocument>;
  phoneNumbers: Collection<PhoneNumberDocument>;
  calls: Collection<CallDocument>;
  smsMessages: Collection<SmsMessageDocument>;
  policies: Collection<PolicyDocument>;
  webhookEvents: Collection<WebhookEventDocument>;
  billingAccounts: Collection<BillingAccountDocument>;
  usageEvents: Collection<UsageEventDocument>;
  usageReports: Collection<UsageReportDocument>;
  pairingRequests: Collection<PairingRequestDocument>;
  opsStatus: Collection<OpsStatusDocument>;
  accountExports: Collection<AccountExportDocument>;
  migrations: Collection<MigrationDocument>;
}

export interface Database {
  client: MongoClient;
  db: Db;
  collections: Collections;
}

export async function connectDatabase(config: AppConfig): Promise<Database> {
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const collections: Collections = {
    users: db.collection<UserDocument>("users"),
    sessions: db.collection<SessionDocument>("sessions"),
    sites: db.collection<SiteDocument>("sites"),
    apiKeys: db.collection<ApiKeyDocument>("apiKeys"),
    atlasProjects: db.collection<AtlasProjectDocument>("atlasProjects"),
    interactionLogs: db.collection<InteractionLogDocument>("interactionLogs"),
    agents: db.collection<AgentDocument>("agents"),
    identityTokens: db.collection<IdentityTokenDocument>("identityTokens"),
    auditLogs: db.collection<AuditLogDocument>("auditLogs"),
    approvals: db.collection<ApprovalDocument>("approvals"),
    emailAccounts: db.collection<EmailAccountDocument>("emailAccounts"),
    emailThreads: db.collection<EmailThreadDocument>("emailThreads"),
    emailMessages: db.collection<EmailMessageDocument>("emailMessages"),
    phoneNumbers: db.collection<PhoneNumberDocument>("phoneNumbers"),
    calls: db.collection<CallDocument>("calls"),
    smsMessages: db.collection<SmsMessageDocument>("smsMessages"),
    policies: db.collection<PolicyDocument>("policies"),
    webhookEvents: db.collection<WebhookEventDocument>("webhookEvents"),
    billingAccounts: db.collection<BillingAccountDocument>("billingAccounts"),
    usageEvents: db.collection<UsageEventDocument>("usageEvents"),
    usageReports: db.collection<UsageReportDocument>("usageReports"),
    pairingRequests: db.collection<PairingRequestDocument>("pairingRequests"),
    opsStatus: db.collection<OpsStatusDocument>("opsStatus"),
    accountExports: db.collection<AccountExportDocument>("accountExports"),
    migrations: db.collection<MigrationDocument>("migrations")
  };

  await Promise.all([
    collections.users.createIndex({ email: 1 }, { unique: true }),
    collections.users.createIndex({ emailHash: 1 }, { sparse: true }),
    collections.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.sessions.createIndex({ idleExpiresAt: 1 }),
    collections.sites.createIndex({ ownerUserId: 1 }),
    collections.sites.createIndex({ publicSiteKey: 1 }, { unique: true }),
    collections.apiKeys.createIndex({ keyHash: 1 }, { unique: true }),
    collections.apiKeys.createIndex({ userId: 1 }),
    collections.apiKeys.createIndex({ userId: 1, siteId: 1, createdAt: -1 }),
    collections.apiKeys.createIndex({ userId: 1, projectId: 1, createdAt: -1 }),
    collections.atlasProjects.createIndex({ projectId: 1 }, { unique: true }),
    collections.atlasProjects.createIndex({ ownerUserId: 1 }),
    collections.interactionLogs.createIndex({ siteId: 1, createdAt: -1 }),
    collections.agents.createIndex({ ownerUserId: 1 }),
    collections.agents.createIndex({ slug: 1, ownerUserId: 1 }, { unique: true }),
    collections.identityTokens.createIndex({ tokenHash: 1 }, { unique: true }),
    collections.identityTokens.createIndex({ agentId: 1 }),
    collections.auditLogs.createIndex({ agentId: 1, createdAt: -1 }),
    collections.auditLogs.createIndex({ ownerUserId: 1, createdAt: -1 }),
    collections.approvals.createIndex({ ownerUserId: 1, status: 1, createdAt: -1 }),
    // Plain index only: a periodic job flips status to "expired"; TTL deletion would lose rows.
    collections.approvals.createIndex({ expiresAt: 1 }),
    collections.emailAccounts.createIndex({ address: 1 }, { unique: true }),
    collections.emailThreads.createIndex({ agentId: 1, lastMessageAt: -1 }),
    collections.emailThreads.createIndex({ agentId: 1, counterpartyEmail: 1 }),
    collections.emailMessages.createIndex({ threadId: 1, createdAt: 1 }),
    collections.emailMessages.createIndex({ agentId: 1, createdAt: -1 }),
    collections.emailMessages.createIndex({ providerMessageId: 1 }, { sparse: true }),
    collections.emailMessages.createIndex(
      { agentId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: "email_agent_idempotency_unique",
        partialFilterExpression: { idempotencyKey: { $exists: true } }
      }
    ),
    collections.phoneNumbers.createIndex({ e164: 1 }, { unique: true }),
    collections.phoneNumbers.createIndex({ agentId: 1 }),
    collections.calls.createIndex({ agentId: 1, createdAt: -1 }),
    collections.calls.createIndex({ providerCallId: 1 }, { sparse: true, unique: true }),
    collections.calls.createIndex({ elevenLabsConversationId: 1 }, { sparse: true }),
    collections.smsMessages.createIndex({ agentId: 1, createdAt: -1 }),
    collections.smsMessages.createIndex({ twilioMessageSid: 1 }, { sparse: true, unique: true }),
    collections.smsMessages.createIndex(
      { agentId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: "sms_agent_idempotency_unique",
        partialFilterExpression: { idempotencyKey: { $exists: true } }
      }
    ),
    collections.policies.createIndex({ agentId: 1 }, { unique: true }),
    collections.webhookEvents.createIndex({ provider: 1, providerEventId: 1 }, { unique: true }),
    collections.billingAccounts.createIndex({ ownerUserId: 1 }, { unique: true }),
    collections.usageEvents.createIndex({ ownerUserId: 1, periodKey: 1, meter: 1 }),
    collections.usageEvents.createIndex({ dedupeKey: 1 }, { unique: true, sparse: true }),
    collections.usageReports.createIndex({ ownerUserId: 1, periodKey: 1, meter: 1 }, { unique: true }),
    collections.pairingRequests.createIndex({ code: 1 }, { unique: true }),
    collections.pairingRequests.createIndex({ status: 1, expiresAt: 1 }),
    collections.opsStatus.createIndex({ key: 1 }, { unique: true }),
    collections.accountExports.createIndex({ ownerUserId: 1, createdAt: -1 }),
    collections.accountExports.createIndex({ expiresAt: 1 }),
    collections.migrations.createIndex({ name: 1 }, { unique: true })
  ]);

  return { client, db, collections };
}
