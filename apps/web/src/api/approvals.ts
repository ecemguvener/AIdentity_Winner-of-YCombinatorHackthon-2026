import { requestJson } from "./client";
import type { Approval, ApprovalsListResponse } from "./types";

export const approvalsApi = {
  list: (status: "pending" | "all" = "pending", cursor?: string) => {
    const search = new URLSearchParams({ status });
    if (cursor) search.set("cursor", cursor);
    return requestJson<ApprovalsListResponse>(`/api/v1/approvals?${search.toString()}`);
  },
  approve: (approvalId: string, note?: string) =>
    requestJson<{ approval: Approval }>(`/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {})
    }),
  reject: (approvalId: string, note?: string) =>
    requestJson<{ approval: Approval }>(`/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {})
    })
};
