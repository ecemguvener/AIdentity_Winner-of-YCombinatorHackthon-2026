import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { ObjectId } from "mongodb";
import { loadConfig, type AppConfig } from "./config.js";
import { connectDatabase, type AgentDocument, type ApprovalDocument, type AuditLogDocument, type BillingAccountDocument, type CallDocument, type Collections, type Database, type EmailAccountDocument, type EmailMessageDocument, type EmailThreadDocument, type IdentityTokenDocument, type PhoneNumberDocument, type PolicyDocument, type SmsMessageDocument, type UsageEventDocument, type UserDocument } from "./db.js";
import { AUDIT_ACTIONS } from "./audit.js";
import { hashApiKey, hashPassword } from "./security.js";

const defaultDemoEmail = "demo@barkan.dev";
const defaultDemoPassword = "demo-password";
const defaultDemoDisplayName = "Barkan Demo";

export interface SeedDemoOptions {
  email?: string;
  password?: string;
  displayName?: string;
  now?: Date;
}

export interface SeedDemoResult {
  email: string;
  password: string;
  agents: string[];
  counts: Record<string, number>;
}

export async function seedDemo(config: AppConfig = loadConfig(), options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const database = await connectDatabase(config);
  try {
    assertDemoSeedAllowed(config, database);
    return await seedDemoWithDatabase(database, config, options);
  } finally {
    await database.client.close();
  }
}

export async function seedDemoWithDatabase(
  database: Database,
  config: AppConfig,
  options: SeedDemoOptions = {}
): Promise<SeedDemoResult> {
  assertDemoSeedAllowed(config, database);
  const email = normalizeDemoEmail(options.email ?? process.env.DEMO_EMAIL ?? defaultDemoEmail);
  const password = options.password ?? process.env.DEMO_PASSWORD ?? defaultDemoPassword;
  const displayName = options.displayName ?? process.env.DEMO_NAME ?? defaultDemoDisplayName;
  const now = options.now ?? new Date();
  const user = await upsertDemoUser(database.collections, email, password, displayName, now);
  await resetDemoData(database.collections, user._id);
  const seeded = buildDemoData(user, now);
  await insertDemoData(database.collections, seeded);
  return {
    email,
    password,
    agents: seeded.agents.map((agent) => agent.name),
    counts: await countDemoData(database.collections, user._id)
  };
}

export function assertDemoSeedAllowed(config: AppConfig, database: Pick<Database, "db">): void {
  if (config.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data while NODE_ENV=production.");
  }
  if (database.db.databaseName.endsWith("-prod")) {
    throw new Error(`Refusing to seed demo data into production database ${database.db.databaseName}.`);
  }
}

interface DemoData {
  agents: AgentDocument[];
  tokens: IdentityTokenDocument[];
  billingAccount: BillingAccountDocument;
  policies: PolicyDocument[];
  emailAccounts: EmailAccountDocument[];
  emailThreads: EmailThreadDocument[];
  emailMessages: EmailMessageDocument[];
  phoneNumbers: PhoneNumberDocument[];
  calls: CallDocument[];
  smsMessages: SmsMessageDocument[];
  approvals: ApprovalDocument[];
  usageEvents: UsageEventDocument[];
  auditLogs: AuditLogDocument[];
}

function buildDemoData(user: UserDocument, now: Date): DemoData {
  const at = relativeDateFactory(now);
  const maya = agent(user, "maya-executive-assistant", "Maya - Executive assistant", "Executive assistant for scheduling, follow-ups, and live calls.", "openclaw", { email: true, phone: true }, at.days(13));
  const scout = agent(user, "scout-recruiting-outreach", "Scout - Recruiting outreach", "Recruiting sourcer that sends structured outreach and waits for owner approval.", "hermes", { email: true, phone: false }, at.days(9));
  const sentinelle = agent(user, "sentinelle-support-line", "Sentinelle - Support line", "Inbound support line that summarizes calls and escalates blocked callers.", "api", { email: false, phone: true }, at.days(5));
  const agents = [maya, scout, sentinelle];
  const emailAccounts = [
    emailAccount(maya, "maya@agents.barkan.dev", "Maya", at.days(13)),
    emailAccount(scout, "scout@agents.barkan.dev", "Scout", at.days(9))
  ];
  const mayaPhone = phoneNumber(maya, "+33186426157", "FR", at.days(13));
  const sentinellePhone = phoneNumber(sentinelle, "+14155550144", "US", at.days(5));
  const phoneNumbers = [mayaPhone, sentinellePhone];
  const policies = [
    policy(maya, {
      requireApproval: "new_recipients",
      dailySendLimit: 80
    }, {
      requireApprovalOutboundCall: "new_recipients",
      requireApprovalSms: "new_recipients",
      allowedCountries: ["FR", "US", "GB"],
      blockedCallers: [],
      inboundInstructions: "Answer as Maya, Maxence's executive assistant. Collect scheduling details and promise a written recap.",
      dailyCallLimit: 30,
      dailySmsLimit: 80,
      quietHours: { start: "20:00", end: "08:00", timezone: "Europe/Paris" },
      inboundEnabled: true,
      storeTranscripts: true
    }, at.days(13)),
    policy(scout, {
      requireApproval: "new_recipients",
      allowedRecipients: ["@example.com", "@talent.test"],
      blockedRecipients: [],
      dailySendLimit: 35,
      maxRecipientsPerMessage: 3
    }, undefined, at.days(9)),
    policy(sentinelle, undefined, {
      requireApprovalOutboundCall: "always",
      requireApprovalSms: "new_recipients",
      allowedCountries: ["US"],
      blockedCallers: ["+14155559999"],
      inboundInstructions: "Triage support callers, summarize the issue, collect order IDs, and escalate urgent safety reports.",
      dailyCallLimit: 45,
      dailySmsLimit: 25,
      quietHours: null,
      inboundEnabled: true,
      storeTranscripts: true
    }, at.days(5))
  ];
  const { threads, messages } = buildEmailStory(maya, scout, at);
  const calls = [
    ...mayaCalls(maya, mayaPhone, at),
    ...sentinelleCalls(sentinelle, sentinellePhone, at)
  ];
  const smsMessages = buildSmsStory(maya, mayaPhone, at);
  const approvals = buildApprovals(scout, at);
  const usageEvents = buildUsage(user, maya, now);
  const tokens = agents.map((item, index) => token(item, ["OpenClaw demo token", "Hermes outreach token", "Support API token"][index]!, at.hours(10 + index * 7)));
  const auditLogs = buildAuditLog(user, agents, threads, messages, calls, smsMessages, approvals, at);

  return {
    agents,
    tokens,
    billingAccount: {
      _id: demoId(user._id, "billing"),
      ownerUserId: user._id,
      stripeCustomerId: "cus_demo_barkan_local",
      plan: "pro",
      subscriptionStatus: "active",
      subscriptionId: "sub_demo_barkan_local",
      currentPeriodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      createdAt: at.days(13),
      updatedAt: now
    },
    policies,
    emailAccounts,
    emailThreads: threads,
    emailMessages: messages,
    phoneNumbers,
    calls,
    smsMessages,
    approvals,
    usageEvents,
    auditLogs
  };
}

function buildEmailStory(maya: AgentDocument, scout: AgentDocument, at: ReturnType<typeof relativeDateFactory>) {
  const threadInputs = [
    [maya, "camille@atelierdemo.test", "Schedule Atelier review", ["Maya proposed Tue 10:30.", "Camille confirmed Tue 10:30 and requested a quiet room."], "inbound"],
    [maya, "noah@investor.test", "Q3 board prep", ["Maya sent the board deck checklist.", "Noah asked for one more retention chart."], "inbound"],
    [maya, "travel@concierge.test", "Paris train change", ["Outbound change request sent.", "Concierge moved the ticket to 18:12."], "inbound"],
    [maya, "legal@example.com", "NDA follow-up", ["Maya requested countersignature.", "Legal confirmed countersignature tomorrow."], "inbound"],
    [maya, "ops@example.com", "Launch room hold", ["Maya held the launch room.", "Ops asked for backup AV."], "inbound"],
    [maya, "alex@example.com", "Dinner window", ["Maya asked for a 19:30 table.", "Alex confirmed 19:45 works."], "inbound"],
    [scout, "rhea@talent.test", "Staff engineer intro", ["Scout drafted a concise intro.", "Rhea replied with availability."], "inbound"],
    [scout, "marco@example.com", "ML infra role", ["Scout sent outreach.", "Mailbox accepted."], "outbound"],
    [scout, "bad-address@example.invalid", "Product lead intro", ["Scout attempted outreach.", "Provider returned mailbox not found."], "bounce"],
    [scout, "lin@talent.test", "Platform role", ["Scout queued a follow-up.", "Lin asked for compensation range."], "inbound"]
  ] as const;
  const threads: EmailThreadDocument[] = [];
  const messages: EmailMessageDocument[] = [];
  threadInputs.forEach(([agentDoc, counterparty, subject, snippets, mode], index) => {
    const threadId = demoId(agentDoc._id, `thread:${counterparty}`);
    const threadAt = at.hours(220 - index * 13);
    threads.push({
      _id: threadId,
      agentId: agentDoc._id,
      counterpartyEmail: counterparty,
      subject,
      lastMessageAt: threadAt,
      messageCount: mode === "outbound" ? 1 : 2,
      createdAt: at.hours(230 - index * 13),
      updatedAt: threadAt
    });
    messages.push(emailMessage(agentDoc, threadId, "outbound", agentDoc.name.startsWith("Maya") ? "maya@agents.barkan.dev" : "scout@agents.barkan.dev", counterparty, subject, snippets[0], "sent", at.hours(232 - index * 13)));
    if (mode !== "outbound") {
      messages.push(emailMessage(agentDoc, threadId, "inbound", counterparty, agentDoc.name.startsWith("Maya") ? "maya@agents.barkan.dev" : "scout@agents.barkan.dev", `Re: ${subject}`, snippets[1], mode === "bounce" ? "bounced" : "received", threadAt, mode === "bounce" ? "Mailbox not found. Outreach should be corrected before retry." : snippets[1]));
    }
  });
  return { threads, messages };
}

function mayaCalls(agentDoc: AgentDocument, phone: PhoneNumberDocument, at: ReturnType<typeof relativeDateFactory>): CallDocument[] {
  return [
    call(agentDoc, phone, "outbound", "+33142860000", "Confirm lunch reservation", "completed", 7, 380, "Restaurant confirmed a table for three at 12:30.", at.hours(10)),
    call(agentDoc, phone, "inbound", "+447700900123", "Investor callback", "completed", 9, 520, "Investor asked to move tomorrow's call to 16:00 Paris.", at.hours(22)),
    call(agentDoc, phone, "outbound", "+33144000000", "Move train ticket", "completed", 4, 260, "Ticket moved to the later departure.", at.hours(38)),
    call(agentDoc, phone, "outbound", "+14155550198", "Confirm delivery window", "no_answer", 0, null, null, at.hours(50)),
    call(agentDoc, phone, "inbound", "+33612345678", "Vendor callback", "completed", 12, 720, "Vendor confirmed revised invoice timing.", at.hours(69)),
    call(agentDoc, phone, "outbound", "+33155550101", "Book AV support", "completed", 8, 510, "AV support booked for launch room.", at.hours(90)),
    call(agentDoc, phone, "inbound", "+33155550202", "Candidate reschedule", "completed", 5, 310, "Candidate can join Friday at 11:00.", at.hours(120)),
    call(agentDoc, phone, "outbound", "+33155550303", "Hotel late check-in", "completed", 6, 380, "Hotel noted late arrival and ID requirement.", at.hours(145))
  ];
}

function sentinelleCalls(agentDoc: AgentDocument, phone: PhoneNumberDocument, at: ReturnType<typeof relativeDateFactory>): CallDocument[] {
  return [
    call(agentDoc, phone, "inbound", "+14155550111", "Order status", "completed", 6, 360, "Caller asked for order A-1042 status; escalation not needed.", at.hours(8)),
    call(agentDoc, phone, "inbound", "+14155550112", "Refund question", "completed", 11, 660, "Caller requested refund policy and accepted email follow-up.", at.hours(18)),
    call(agentDoc, phone, "inbound", "+14155550113", "Urgent delivery miss", "completed", 13, 780, "Urgent delivery miss escalated to operations.", at.hours(42)),
    call(agentDoc, phone, "inbound", "+14155550114", "Warranty question", "completed", 4, 240, "Warranty window confirmed.", at.hours(66)),
    call(agentDoc, phone, "outbound", "+14155550113", "Delivery follow-up", "completed", 7, 420, "Operations follow-up completed; caller satisfied.", at.hours(80)),
    call(agentDoc, phone, "inbound", "+14155559999", "Blocked caller", "failed", 0, null, "Caller matched blocked-caller policy.", at.hours(96))
  ];
}

function buildSmsStory(agentDoc: AgentDocument, phone: PhoneNumberDocument, at: ReturnType<typeof relativeDateFactory>): SmsMessageDocument[] {
  return [
    sms(agentDoc, phone, "inbound", "+14155550999", "Your verification code is 482913.", "received", at.hours(5)),
    sms(agentDoc, phone, "outbound", "+14155550999", "Code received. Continuing setup.", "sent", new Date(at.hours(5).getTime() + 60_000)),
    sms(agentDoc, phone, "inbound", "+14155550999", "Reminder: code expires in 10 minutes.", "received", at.hours(4))
  ];
}

function buildApprovals(agentDoc: AgentDocument, at: ReturnType<typeof relativeDateFactory>): ApprovalDocument[] {
  return [
    approval(agentDoc, "email.send", "Send email to nina@newco.test: Recruiting intro", { to: "nina@newco.test", subject: "Recruiting intro", text: "Short intro for a platform role." }, at.hours(1)),
    approval(agentDoc, "email.send", "Send email to devon@newco.test: Staff engineer follow-up", { to: "devon@newco.test", subject: "Staff engineer follow-up", text: "Follow-up after referral." }, at.hours(2))
  ];
}

function buildUsage(user: UserDocument, agentDoc: AgentDocument, now: Date): UsageEventDocument[] {
  const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return [
    usage(user, agentDoc, "emails_sent", 340, periodKey, now),
    usage(user, agentDoc, "call_minutes", 74, periodKey, now),
    usage(user, agentDoc, "sms_messages", 41, periodKey, now)
  ];
}

function buildAuditLog(user: UserDocument, agents: AgentDocument[], threads: EmailThreadDocument[], messages: EmailMessageDocument[], calls: CallDocument[], smsMessages: SmsMessageDocument[], approvals: ApprovalDocument[], at: ReturnType<typeof relativeDateFactory>): AuditLogDocument[] {
  const rng = createRng(57);
  const audits: AuditLogDocument[] = [];
  const push = (agentDoc: AgentDocument, actor: AuditLogDocument["actor"], action: string, status: AuditLogDocument["status"], detail: string, createdAt: Date, metadata: Record<string, unknown> = {}) => {
    audits.push({
      _id: demoId(agentDoc._id, `audit:${audits.length}:${action}`),
      agentId: agentDoc._id,
      ownerUserId: user._id,
      actor,
      action,
      status,
      detail,
      ...(Object.keys(metadata).length ? { metadata } : {}),
      createdAt
    });
  };
  for (const agentDoc of agents) push(agentDoc, "owner", "agent.create", "allowed", `${agentDoc.name} created.`, agentDoc.createdAt);
  for (const message of messages) push(agents.find((item) => item._id.equals(message.agentId))!, message.direction === "outbound" ? "agent" : "system", message.direction === "outbound" ? AUDIT_ACTIONS.email.send : AUDIT_ACTIONS.email.receive, message.status === "bounced" ? "error" : "allowed", `${message.direction === "outbound" ? "Email sent to" : "Email received from"} ${message.direction === "outbound" ? message.toEmail : message.fromEmail}: ${message.subject}`, message.createdAt, { threadId: message.threadId.toHexString() });
  for (const item of calls) push(agents.find((agentDoc) => agentDoc._id.equals(item.agentId))!, item.direction === "outbound" ? "agent" : "system", item.direction === "outbound" ? AUDIT_ACTIONS.phone.outbound : AUDIT_ACTIONS.phone.inbound, item.status === "failed" ? "blocked" : "allowed", item.summary ?? item.task ?? "Phone call", item.createdAt);
  for (const item of smsMessages) push(agents.find((agentDoc) => agentDoc._id.equals(item.agentId))!, item.direction === "outbound" ? "agent" : "system", item.direction === "outbound" ? AUDIT_ACTIONS.sms.send : AUDIT_ACTIONS.sms.receive, "allowed", `${item.direction === "outbound" ? "SMS sent to" : "SMS received from"} ${item.counterpartyE164}`, item.createdAt);
  for (const item of approvals) push(agents.find((agentDoc) => agentDoc._id.equals(item.agentId))!, "agent", AUDIT_ACTIONS.approval.requested, "pending", item.payloadSummary, item.createdAt);
  while (audits.length < 72) {
    const agentDoc = agents[Math.floor(rng() * agents.length)]!;
    const action = [AUDIT_ACTIONS.policy.updated, "agent.token.create", AUDIT_ACTIONS.approval.approved, AUDIT_ACTIONS.phone.blocked][Math.floor(rng() * 4)]!;
    push(agentDoc, action === AUDIT_ACTIONS.phone.blocked ? "system" : "owner", action, action === AUDIT_ACTIONS.phone.blocked ? "blocked" : "allowed", fillerDetail(action, agentDoc.name), at.hours(Math.floor(rng() * 14 * 24)));
  }
  return audits.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

async function upsertDemoUser(collections: Collections, email: string, password: string, displayName: string, now: Date): Promise<UserDocument> {
  const existing = await collections.users.findOne({ email });
  const update = {
    displayName,
    avatarUrl: null,
    notificationPreferences: { productEmails: true, identityEmails: true, securityEmails: true },
    passwordHash: await hashPassword(password),
    onboarding: {
      completedAt: now,
      dismissedAt: now,
      events: [
        { step: "agent_created" as const, at: addMinutes(now, -40) },
        { step: "runtime_connected" as const, at: addMinutes(now, -34) },
        { step: "first_email_sent" as const, at: addMinutes(now, -25) },
        { step: "approval_decided" as const, at: addMinutes(now, -22) }
      ]
    },
    updatedAt: now
  };
  if (existing) {
    await collections.users.updateOne({ _id: existing._id }, { $set: update });
    return { ...existing, ...update };
  }
  const user: UserDocument = {
    _id: demoId(email, "user"),
    email,
    ...update,
    createdAt: new Date(now.getTime() - 21 * 24 * 60 * 60_000)
  };
  await collections.users.insertOne(user);
  return user;
}

async function resetDemoData(collections: Collections, ownerUserId: ObjectId): Promise<void> {
  const agents = await collections.agents.find({ ownerUserId }, { projection: { _id: 1 } }).toArray();
  const agentIds = agents.map((agentDoc) => agentDoc._id);
  const sites = await collections.sites.find({ ownerUserId }, { projection: { _id: 1 } }).toArray();
  const siteIds = sites.map((site) => site._id);
  await Promise.all([
    collections.agents.deleteMany({ ownerUserId }),
    collections.identityTokens.deleteMany({ $or: [{ ownerUserId }, { agentId: { $in: agentIds } }] }),
    collections.auditLogs.deleteMany({ ownerUserId }),
    collections.approvals.deleteMany({ ownerUserId }),
    collections.emailAccounts.deleteMany({ agentId: { $in: agentIds } }),
    collections.emailThreads.deleteMany({ agentId: { $in: agentIds } }),
    collections.emailMessages.deleteMany({ agentId: { $in: agentIds } }),
    collections.phoneNumbers.deleteMany({ agentId: { $in: agentIds } }),
    collections.calls.deleteMany({ agentId: { $in: agentIds } }),
    collections.smsMessages.deleteMany({ agentId: { $in: agentIds } }),
    collections.policies.deleteMany({ agentId: { $in: agentIds } }),
    collections.billingAccounts.deleteMany({ ownerUserId }),
    collections.usageEvents.deleteMany({ ownerUserId }),
    collections.usageReports.deleteMany({ ownerUserId }),
    collections.pairingRequests.deleteMany({ ownerUserId }),
    collections.accountExports.deleteMany({ ownerUserId }),
    collections.apiKeys.deleteMany({ userId: ownerUserId }),
    collections.atlasProjects.deleteMany({ ownerUserId }),
    siteIds.length ? collections.interactionLogs.deleteMany({ siteId: { $in: siteIds } }) : Promise.resolve(),
    collections.sites.deleteMany({ ownerUserId })
  ]);
}

async function insertDemoData(collections: Collections, data: DemoData): Promise<void> {
  await collections.billingAccounts.insertOne(data.billingAccount);
  await collections.agents.insertMany(data.agents);
  await collections.identityTokens.insertMany(data.tokens);
  await collections.policies.insertMany(data.policies);
  await collections.emailAccounts.insertMany(data.emailAccounts);
  await collections.emailThreads.insertMany(data.emailThreads);
  await collections.emailMessages.insertMany(data.emailMessages);
  await collections.phoneNumbers.insertMany(data.phoneNumbers);
  await collections.calls.insertMany(data.calls);
  await collections.smsMessages.insertMany(data.smsMessages);
  await collections.approvals.insertMany(data.approvals);
  await collections.usageEvents.insertMany(data.usageEvents);
  await collections.auditLogs.insertMany(data.auditLogs);
}

async function countDemoData(collections: Collections, ownerUserId: ObjectId): Promise<Record<string, number>> {
  const agentIds = (await collections.agents.find({ ownerUserId }).project<{ _id: ObjectId }>({ _id: 1 }).toArray()).map((agentDoc) => agentDoc._id);
  return {
    agents: await collections.agents.countDocuments({ ownerUserId }),
    emailThreads: await collections.emailThreads.countDocuments({ agentId: { $in: agentIds } }),
    emailMessages: await collections.emailMessages.countDocuments({ agentId: { $in: agentIds } }),
    calls: await collections.calls.countDocuments({ agentId: { $in: agentIds } }),
    smsMessages: await collections.smsMessages.countDocuments({ agentId: { $in: agentIds } }),
    approvals: await collections.approvals.countDocuments({ ownerUserId }),
    usageEvents: await collections.usageEvents.countDocuments({ ownerUserId }),
    auditLogs: await collections.auditLogs.countDocuments({ ownerUserId })
  };
}

function agent(user: UserDocument, slug: string, name: string, description: string, runtime: AgentDocument["runtime"], capabilities: AgentDocument["capabilities"], createdAt: Date): AgentDocument {
  return {
    _id: demoId(user._id, `agent:${slug}`),
    ownerUserId: user._id,
    name,
    slug,
    status: "active",
    description,
    runtime,
    capabilities,
    approvalMode: "policy",
    createdAt,
    updatedAt: new Date(createdAt.getTime() + 3 * 60 * 60_000)
  };
}

function token(agentDoc: AgentDocument, name: string, lastUsedAt: Date): IdentityTokenDocument {
  const plaintext = `brk_demo_${agentDoc.slug}_local_only`;
  return {
    _id: demoId(agentDoc._id, `token:${name}`),
    agentId: agentDoc._id,
    ownerUserId: agentDoc.ownerUserId,
    tokenHash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, 12),
    name,
    status: "active",
    lastUsedAt,
    lastUsedIp: "127.0.0.1",
    createdAt: agentDoc.createdAt,
    updatedAt: lastUsedAt
  };
}

function emailAccount(agentDoc: AgentDocument, address: string, displayName: string, createdAt: Date): EmailAccountDocument {
  return { _id: demoId(agentDoc._id, `email:${address}`), agentId: agentDoc._id, address, displayName, status: "active", createdAt, updatedAt: createdAt };
}

function phoneNumber(agentDoc: AgentDocument, e164: string, country: string, createdAt: Date): PhoneNumberDocument {
  return { _id: demoId(agentDoc._id, `phone:${e164}`), agentId: agentDoc._id, e164, country, twilioSid: `PN_demo_${e164.replace(/\D/g, "")}`, elevenLabsPhoneNumberId: `el_demo_${agentDoc.slug}`, capabilitiesVoice: true, capabilitiesSms: true, status: "active", monthlyPriceCents: 200, createdAt, updatedAt: createdAt };
}

function policy(agentDoc: AgentDocument, emailPatch: Partial<PolicyDocument["email"]> = {}, phonePatch: Partial<Record<string, unknown>> = {}, createdAt: Date): PolicyDocument {
  return {
    _id: demoId(agentDoc._id, "policy"),
    agentId: agentDoc._id,
    email: {
      requireApproval: "new_recipients",
      allowedRecipients: [],
      blockedRecipients: [],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5,
      ...emailPatch
    },
    phone: {
      requireApprovalOutboundCall: "new_recipients",
      requireApprovalSms: "new_recipients",
      allowedCountries: [],
      inboundEnabled: true,
      blockedCallers: [],
      inboundInstructions: "Answer naturally as the agent identity.",
      dailyCallLimit: 20,
      dailySmsLimit: 50,
      quietHours: null,
      storeTranscripts: true,
      ...phonePatch
    },
    createdAt,
    updatedAt: createdAt
  };
}

function emailMessage(agentDoc: AgentDocument, threadId: ObjectId, direction: "inbound" | "outbound", fromEmail: string, toEmail: string, subject: string, text: string, status: EmailMessageDocument["status"], createdAt: Date, summary?: string): EmailMessageDocument {
  return {
    _id: demoId(threadId, `message:${direction}:${createdAt.toISOString()}`),
    agentId: agentDoc._id,
    threadId,
    direction,
    fromEmail,
    toEmail,
    subject,
    textBody: text,
    providerMessageId: `msg_demo_${crypto.createHash("sha1").update(`${threadId}:${createdAt.toISOString()}`).digest("hex").slice(0, 12)}`,
    parsedBy: direction === "inbound" ? "heuristic" : null,
    status,
    summary,
    suggestedReply: direction === "inbound" && status === "received" ? "Thanks for the update. I will confirm the next step shortly." : undefined,
    createdAt,
    updatedAt: createdAt
  };
}

function call(agentDoc: AgentDocument, phone: PhoneNumberDocument, direction: CallDocument["direction"], counterparty: string, task: string, status: CallDocument["status"], durationMinutes: number, costCents: number | null, summary: string | null, createdAt: Date): CallDocument {
  return {
    _id: demoId(agentDoc._id, `call:${counterparty}:${createdAt.toISOString()}`),
    agentId: agentDoc._id,
    phoneNumberId: phone._id,
    direction,
    counterpartyE164: counterparty,
    task,
    status,
    providerCallId: `call_demo_${crypto.createHash("sha1").update(`${agentDoc.slug}:${counterparty}:${createdAt.toISOString()}`).digest("hex").slice(0, 10)}`,
    elevenLabsConversationId: status === "completed" ? `conv_demo_${crypto.createHash("sha1").update(`${counterparty}:${task}`).digest("hex").slice(0, 10)}` : undefined,
    durationSecs: durationMinutes ? durationMinutes * 60 : undefined,
    transcript: status === "completed" ? [
      { role: "agent", message: `Hi, this is ${agentDoc.name.split(" - ")[0]} calling about ${task.toLowerCase()}.`, timeInCallSecs: 2 },
      { role: "user", message: summary ?? "Confirmed.", timeInCallSecs: 28 }
    ] : [],
    summary: summary ?? undefined,
    costCents: costCents ?? undefined,
    createdAt,
    updatedAt: new Date(createdAt.getTime() + Math.max(1, durationMinutes) * 60_000)
  };
}

function sms(agentDoc: AgentDocument, phone: PhoneNumberDocument, direction: SmsMessageDocument["direction"], counterparty: string, body: string, status: SmsMessageDocument["status"], createdAtMs: Date | number): SmsMessageDocument {
  const createdAt = typeof createdAtMs === "number" ? new Date(createdAtMs) : createdAtMs;
  return {
    _id: demoId(agentDoc._id, `sms:${counterparty}:${createdAt.toISOString()}`),
    agentId: agentDoc._id,
    phoneNumberId: phone._id,
    direction,
    counterpartyE164: counterparty,
    body,
    twilioMessageSid: `SM_demo_${crypto.createHash("sha1").update(body + createdAt.toISOString()).digest("hex").slice(0, 14)}`,
    status,
    createdAt,
    updatedAt: createdAt
  };
}

function approval(agentDoc: AgentDocument, kind: ApprovalDocument["kind"], payloadSummary: string, payload: Record<string, unknown>, createdAt: Date): ApprovalDocument {
  return {
    _id: demoId(agentDoc._id, `approval:${payloadSummary}`),
    agentId: agentDoc._id,
    ownerUserId: agentDoc.ownerUserId!,
    kind,
    status: "pending",
    payloadSummary,
    payload,
    expiresAt: new Date(createdAt.getTime() + 60 * 60_000),
    createdAt,
    updatedAt: createdAt
  };
}

function usage(user: UserDocument, agentDoc: AgentDocument, meter: UsageEventDocument["meter"], quantity: number, periodKey: string, now: Date): UsageEventDocument {
  return {
    _id: demoId(user._id, `usage:${meter}:${periodKey}`),
    ownerUserId: user._id,
    agentId: agentDoc._id,
    meter,
    quantity,
    stripeReported: false,
    periodKey,
    dedupeKey: `demo:${user._id.toHexString()}:${meter}:${periodKey}`,
    createdAt: now,
    updatedAt: now
  };
}

function fillerDetail(action: string, agentName: string): string {
  if (action === AUDIT_ACTIONS.policy.updated) return `${agentName} policy adjusted for demo scenario.`;
  if (action === "agent.token.create") return `${agentName} runtime token rotated for local demo.`;
  if (action === AUDIT_ACTIONS.phone.blocked) return `${agentName} blocked a caller by phone policy.`;
  return `${agentName} approval decision recorded.`;
}

function relativeDateFactory(now: Date) {
  return {
    days: (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000),
    hours: (hours: number) => new Date(now.getTime() - hours * 60 * 60_000)
  };
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function demoId(...parts: Array<string | ObjectId>): ObjectId {
  const input = parts.map((part) => part instanceof ObjectId ? part.toHexString() : part).join(":");
  return new ObjectId(crypto.createHash("sha256").update(input).digest("hex").slice(0, 24));
}

function normalizeDemoEmail(value: string): string {
  return value.trim().toLowerCase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  seedDemo(config)
    .then((result) => {
      console.log("Demo account ready.");
      console.log(`Email: ${result.email}`);
      console.log(`Password: ${result.password}`);
      console.log(`Agent identities: ${result.agents.join(", ")}`);
      console.log(`Counts: ${JSON.stringify(result.counts)}`);
      console.log(`Dashboard: ${config.PUBLIC_APP_URL}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
