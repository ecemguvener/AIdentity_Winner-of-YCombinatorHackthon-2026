export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: unknown;
  };
  message?: string;
  legacyError?: string;
}

export interface Agent {
  id: string;
  name: string;
  slug: string;
  status: "provisioning" | "active" | "paused" | "revoked";
  description: string | null;
  runtime: "openclaw" | "hermes" | "api" | "other" | null;
  capabilities: {
    email: boolean;
    phone: boolean;
  };
  approvalMode: "always" | "policy" | "autonomous";
  emailAddress: string | null;
  phoneE164: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningStatus {
  enabled: boolean;
  state: "not_provisioned" | "pending" | "provisioned" | "active" | "paused" | "failed";
  detail?: string;
}

export interface AgentProvisioningSummary {
  email: ProvisioningStatus;
  phone: ProvisioningStatus;
}

export interface IdentityToken {
  id: string;
  name: string;
  prefix: string;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AgentDetailResponse {
  agent: Agent;
  tokens: IdentityToken[];
  provisioning: AgentProvisioningSummary;
}

export interface EmailPolicy {
  requireApproval: "always" | "new_recipients" | "never";
  allowedRecipients: string[];
  blockedRecipients: string[];
  dailySendLimit: number;
  maxRecipientsPerMessage: number;
}

export interface AgentEmailIdentity {
  email_identity_id: string;
  email_address: string;
  display_name: string;
  provider: string;
  status: "active" | "paused";
  created_at: string;
}

export interface AgentEmailThreadListItem {
  id: string;
  counterparty: string;
  subject: string;
  snippet: string;
  lastDirection: "inbound" | "outbound";
  lastMessageAt: string;
  unreadCount: number;
  messageCount: number;
}

export interface AgentEmailThreadsResponse {
  emailIdentity: AgentEmailIdentity | null;
  todaySent: number;
  policy: EmailPolicy;
  threads: AgentEmailThreadListItem[];
  nextCursor: string | null;
}

export interface AgentEmailAttachment {
  filename: string;
  content_type: string;
  size_bytes: number;
  id: string | null;
}

export interface AgentEmailMessage {
  id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  from_email: string;
  to_email: string;
  cc: string[];
  subject: string;
  body: string;
  html: string | null;
  provider_message_id: string | null;
  status: "queued" | "sent" | "delivered" | "failed" | "received";
  parsed_by: "openai" | "heuristic" | null;
  summary: string | null;
  suggested_reply: string | null;
  attachments: AgentEmailAttachment[];
  created_at: string;
}

export interface AgentEmailThreadDetailResponse {
  thread: {
    id: string;
    counterparty: string;
    subject: string;
    lastMessageAt: string;
    messageCount: number;
  };
  messages: AgentEmailMessage[];
}

export type AgentEmailSendResponse =
  | {
      ok: true;
      message_id: string;
      thread_id: string;
      provider_message_id: string | null;
      from: string;
      to: string;
      subject: string;
      status: string;
    }
  | {
      ok: false;
      status: "approval_required";
      decision: "pending" | "timeout" | "expired";
      approval_id: string;
      approval: {
        id: string;
        status: string;
        payloadSummary: string;
        executionResult: unknown;
        executionError: string | null;
      };
    };

export type AgentListItem = Agent & { provisioning: AgentProvisioningSummary };

export interface AgentsListResponse {
  agents: AgentListItem[];
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  runtime?: "openclaw" | "hermes" | "api" | "other";
  capabilities?: Partial<Agent["capabilities"]>;
  approvalMode?: Agent["approvalMode"];
}

export interface CreateAgentResponse {
  agent: Agent;
  identityToken: {
    secret: string;
    prefix: string;
  };
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  approvalMode?: Agent["approvalMode"];
  status?: "active" | "paused";
}

export interface CreateTokenResponse {
  id: string;
  name: string;
  secret: string;
  prefix: string;
}

export interface Approval {
  id: string;
  agentId: string;
  agentName?: string;
  ownerUserId: string;
  kind: "email.send" | "phone.call" | "sms.send";
  status: "pending" | "approved" | "rejected" | "expired";
  payloadSummary: string;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalsListResponse {
  approvals: Approval[];
  nextCursor: string | null;
}
