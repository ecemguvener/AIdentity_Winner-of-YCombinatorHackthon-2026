import { requestJson } from "./client";
import type {
  Agent,
  AgentDetailResponse,
  AgentEmailSendResponse,
  AgentEmailThreadDetailResponse,
  AgentEmailThreadsResponse,
  AgentsListResponse,
  CreateAgentInput,
  CreateAgentResponse,
  CreateTokenResponse,
  EmailPolicy,
  PhonePolicy,
  UpdateAgentInput
} from "./types";

export const agentsApi = {
  list: () => requestJson<AgentsListResponse>("/api/v1/agents"),
  get: (agentId: string) => requestJson<AgentDetailResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}`),
  create: (input: CreateAgentInput) =>
    requestJson<CreateAgentResponse>("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  update: (agentId: string, input: UpdateAgentInput) =>
    requestJson<{ agent: Agent }>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  delete: (agentId: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE"
    }),
  createToken: (agentId: string, name?: string) =>
    requestJson<CreateTokenResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/tokens`, {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  revokeToken: (agentId: string, tokenId: string) =>
    requestJson<{ ok: boolean }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/tokens/${encodeURIComponent(tokenId)}`,
      { method: "DELETE" }
    ),
  enableCapability: (agentId: string, capability: "email" | "phone") =>
    requestJson<{ provisioning: { state: "pending"; capability: "email" | "phone" } }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/capabilities/${capability}/enable`,
      { method: "POST" }
    ),
  disableCapability: (agentId: string, capability: "email" | "phone") =>
    requestJson<{ provisioning: { state: "pending"; capability: "email" | "phone" } }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/capabilities/${capability}/disable`,
      { method: "POST" }
    ),
  getEmailPolicy: (agentId: string) =>
    requestJson<{ policy: EmailPolicy }>(`/api/v1/agents/${encodeURIComponent(agentId)}/policies/email`),
  updateEmailPolicy: (agentId: string, policy: EmailPolicy) =>
    requestJson<{ policy: EmailPolicy }>(`/api/v1/agents/${encodeURIComponent(agentId)}/policies/email`, {
      method: "PUT",
      body: JSON.stringify(policy)
    }),
  getPhonePolicy: (agentId: string) =>
    requestJson<{ policy: PhonePolicy }>(`/api/v1/agents/${encodeURIComponent(agentId)}/policies/phone`),
  updatePhonePolicy: (agentId: string, policy: PhonePolicy) =>
    requestJson<{ policy: PhonePolicy }>(`/api/v1/agents/${encodeURIComponent(agentId)}/policies/phone`, {
      method: "PUT",
      body: JSON.stringify(policy)
    }),
  getEmailThreads: (agentId: string) =>
    requestJson<AgentEmailThreadsResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/email/threads`),
  getEmailThread: (agentId: string, threadId: string) =>
    requestJson<AgentEmailThreadDetailResponse>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/email/threads/${encodeURIComponent(threadId)}`
    ),
  sendEmail: (agentId: string, input: { to: string; cc?: string[]; subject: string; text: string }) =>
    requestJson<AgentEmailSendResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/email/send?mode=async`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  replyEmail: (agentId: string, threadId: string, input: { text: string }) =>
    requestJson<AgentEmailSendResponse>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/email/threads/${encodeURIComponent(threadId)}/reply?mode=async`,
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    ),
  pauseEmail: (agentId: string) =>
    requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/email/pause`, { method: "POST" }),
  resumeEmail: (agentId: string) =>
    requestJson(`/api/v1/agents/${encodeURIComponent(agentId)}/email/resume`, { method: "POST" })
};
