import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

describe("App shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("auth gate renders the authenticated identity dashboard", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({
          user: {
            id: "user_1",
            email: "user@example.com",
            displayName: "User",
            avatarUrl: null,
            notificationPreferences: {
              productEmails: true,
              identityEmails: true,
              securityEmails: true
            },
            createdAt: new Date().toISOString()
          }
        });
      }
      if (url.endsWith("/api/v1/agents")) {
        return jsonResponse({ agents: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    window.history.replaceState({}, "", "/agents");
    render(<AppShell />);

    await waitFor(() => expect(screen.getByText("Identities")).toBeInTheDocument());
    expect(screen.getByText("New identity")).toBeInTheDocument();
    expect(screen.queryByText(/npx barkan connect/i)).not.toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
