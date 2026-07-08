import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCreationWizard } from "./AgentsListPage";

describe("Agent creation wizard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("blocks empty identity names", () => {
    render(<AgentCreationWizard onCancel={vi.fn()} onCreated={vi.fn()} onNotify={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /create identity/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("Please fill in this field.");
  });

  it("reveals the identity token once and masks it after copy", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/billing")) {
        return jsonResponse({ plan: "free" });
      }
      return jsonResponse({
        agent: {
          id: "agent_1",
          name: "Maya",
          slug: "maya",
          status: "active",
          description: null,
          runtime: "openclaw",
          capabilities: { email: true, phone: false },
          approvalMode: "always",
          emailAddress: null,
          phoneE164: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        identityToken: { secret: "barkan_secret_once", prefix: "barkan" }
      }, 201);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<AgentCreationWizard onCancel={vi.fn()} onCreated={vi.fn()} onNotify={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Maya" } });
    fireEvent.click(screen.getByRole("button", { name: /create identity/i }));

    expect(await screen.findByText("barkan_secret_once")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /copy prompt/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("BARKAN_IDENTITY_TOKEN 'barkan_secret_once'"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"BARKAN_IDENTITY_TOKEN": "barkan_secret_once"'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Do not search, install, or verify a barkan-identity OpenClaw skill"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("openclaw mcp set barkan"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("openclaw mcp probe barkan --json"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"mcp":'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"servers":'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/mcp"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("mcpServers"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("openclaw skills install"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("openclaw skills verify"));

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    await waitFor(() => expect(screen.queryByText("barkan_secret_once")).not.toBeInTheDocument());
    expect(screen.getByText("barkan_sec...stored")).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
