import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../api/types";
import { ApprovalsPage } from "./ApprovalsPage";

describe("Approvals page", () => {
  it("approves a pending item optimistically through the supplied handler", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalsPage
        approvals={[approval()]}
        history={[]}
        focusedApprovalId="approval_1"
        onApprove={onApprove}
        onReject={vi.fn()}
        onRefreshHistory={vi.fn()}
        onNotify={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText(/decision note/i), { target: { value: "Looks good" } });
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => expect(onApprove).toHaveBeenCalledWith("approval_1", "Looks good"));
  });
});

function approval(): Approval {
  const now = new Date();
  return {
    id: "approval_1",
    agentId: "agent_1",
    agentName: "Maya",
    ownerUserId: "user_1",
    kind: "email.send",
    status: "pending",
    payloadSummary: "Send email to alice@example.com",
    payload: { to: "alice@example.com", subject: "Hi" },
    decisionNote: null,
    decidedAt: null,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}
