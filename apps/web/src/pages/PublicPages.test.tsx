import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocsSitePage, LandingPage, PricingPage } from "./PublicPages";

describe("Public pages", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("shows honest landing copy for shipped capabilities", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: /give your ai agent a real identity/i })).toBeInTheDocument();
    expect(screen.getByText(/phone number and email address/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Payment cards: coming soon/i)).not.toHaveLength(0);
    expect(screen.queryByText(/Action Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/widget snippet/i)).not.toBeInTheDocument();
  });

  it("submits the card waitlist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { "content-type": "application/json" }
    }));
    render(<LandingPage />);

    fireEvent.change(screen.getByPlaceholderText("work@example.com"), { target: { value: "card@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /join waitlist/i }));

    await waitFor(() => expect(screen.getByText(/you're on the card waitlist/i)).toBeInTheDocument());
    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/waitlist"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "card@example.com", feature: "card" })
    }));
  });

  it("shows current pricing without claiming cards are live", () => {
    render(<PricingPage />);

    expect(screen.getByText(/29 EUR\/mo/i)).toBeInTheDocument();
    expect(screen.getAllByText(/payment cards: coming soon/i)).not.toHaveLength(0);
  });

  it("renders docs pages from markdown", () => {
    render(<DocsSitePage path="/docs-site/integrations/mcp" />);

    expect(screen.getByRole("heading", { name: /barkan mcp integration/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /api reference/i })).toHaveAttribute("href", "/docs");
  });
});
