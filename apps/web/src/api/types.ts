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
