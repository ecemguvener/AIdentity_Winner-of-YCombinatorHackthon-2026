import { requestJson } from "./client";
import type {
  Agent,
  AgentDetailResponse,
  AgentsListResponse,
  CreateAgentInput,
  CreateAgentResponse,
  CreateTokenResponse,
  EmailPolicy,
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
    })
};
