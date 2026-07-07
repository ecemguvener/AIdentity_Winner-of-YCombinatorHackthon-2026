import { requestJson } from "./client";
import type {
  AgentPhoneCall,
  AgentPhoneCallsResponse,
  AgentPhoneOverviewResponse,
  AgentSmsConversationsResponse,
  AgentSmsMessage,
  AgentSmsThreadResponse
} from "./types";

export const phoneApi = {
  getOverview: (agentId: string) =>
    requestJson<AgentPhoneOverviewResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/phone`),
  getCalls: (agentId: string) =>
    requestJson<AgentPhoneCallsResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/phone/calls`),
  getCall: (agentId: string, callId: string) =>
    requestJson<{ call: AgentPhoneCall }>(`/api/v1/agents/${encodeURIComponent(agentId)}/phone/calls/${encodeURIComponent(callId)}`),
  placeCall: (agentId: string, input: { to: string; task: string; recipientName?: string; context?: string }) =>
    requestJson<{ ok: boolean; call_id?: string; status?: string; from?: string; to?: string; approval_id?: string }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/phone/call?mode=async`,
      { method: "POST", body: JSON.stringify(input) }
    ),
  getSmsConversations: (agentId: string) =>
    requestJson<AgentSmsConversationsResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/phone/sms`),
  getSmsThread: (agentId: string, counterparty: string) =>
    requestJson<AgentSmsThreadResponse>(`/api/v1/agents/${encodeURIComponent(agentId)}/phone/sms?with=${encodeURIComponent(counterparty)}`),
  sendSms: (agentId: string, input: { to: string; body: string; idempotencyKey?: string }) =>
    requestJson<{ message?: AgentSmsMessage; ok?: boolean; approval_id?: string }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/phone/sms?mode=async`,
      { method: "POST", body: JSON.stringify(input) }
    )
};
