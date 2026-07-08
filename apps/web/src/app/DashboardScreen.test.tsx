import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../api";
import type { AgentListItem } from "../api/types";
import { DashboardScreen } from "./DashboardScreen";

describe("Dashboard onboarding", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows agent identities without activation checklist chrome", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/billing")) return jsonResponse({ plan: "free" });
      if (url.endsWith("/api/v1/billing/usage")) return jsonResponse({ perMeter: {} });
      if (url.endsWith("/api/v1/ops/status")) {
        return jsonResponse({ providerModes: { email: "mock", phone: "mock", billing: "mock" } });
      }
      return jsonResponse({}, 200);
    });

    renderDashboard(user(), [agent]);

    expect(screen.queryByText("Get to first action")).not.toBeInTheDocument();
    expect(screen.getByText("First Agent")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Live providers are not connected yet.")).toBeInTheDocument());
  });

  it("keeps the checklist hidden once onboarding is complete", () => {
    renderDashboard({
      ...user(),
      onboarding: {
        ...user().onboarding,
        completedAt: "2026-07-07T00:05:00.000Z"
      }
    }, [agent]);

    expect(screen.queryByText("Get to first action")).not.toBeInTheDocument();
  });
});

const agent: AgentListItem = {
  id: "agent_1",
  name: "First Agent",
  slug: "first-agent",
  status: "active",
  description: null,
  runtime: "openclaw",
  capabilities: { email: true, phone: false },
  approvalMode: "always",
  emailAddress: "first-agent@agents.barkan.dev",
  phoneE164: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
  provisioning: {
    email: { enabled: true, state: "active", detail: "first-agent@agents.barkan.dev" },
    phone: { enabled: false, state: "not_provisioned" }
  }
};

function user(): User {
  return {
    id: "user_1",
    email: "owner@example.com",
    displayName: "Owner",
    avatarUrl: null,
    notificationPreferences: { productEmails: true, identityEmails: true, securityEmails: true },
    onboarding: {
      dismissedAt: null,
      completedAt: null,
      steps: {
        agent_created: "2026-07-07T00:01:00.000Z",
        runtime_connected: null,
        first_email_sent: null,
        approval_decided: null
      },
      events: []
    },
    createdAt: "2026-07-07T00:00:00.000Z"
  };
}

function renderDashboard(currentUser: User, agents: AgentListItem[]) {
  return render(
    <DashboardScreen
      error=""
      user={currentUser}
      agents={agents}
      selectedAgentDetail={null}
      activeSection="sites"
      pendingApprovals={[]}
      approvalHistory={[]}
      focusedApprovalId={null}
      activeSiteDetailTab="credentials"
      activeUserSettingsSection="profile"
      onCreateAgent={vi.fn()}
      onLogout={vi.fn()}
      onSelectAgent={vi.fn()}
      onOpenDashboard={vi.fn()}
      onOpenApprovals={vi.fn()}
      onOpenDashboardChat={vi.fn()}
      onOpenProfileSettings={vi.fn()}
      onUserSettingsSectionChange={vi.fn()}
      onUserUpdated={vi.fn()}
      onAgentDetailLoaded={vi.fn()}
      onAgentUpdated={vi.fn()}
      onAgentDeleted={vi.fn()}
      onTokensChanged={vi.fn()}
      onApproveApproval={vi.fn()}
      onRejectApproval={vi.fn()}
      onRefreshApprovalHistory={vi.fn()}
      onNotify={vi.fn()}
      onCloseDetail={vi.fn()}
    />
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
