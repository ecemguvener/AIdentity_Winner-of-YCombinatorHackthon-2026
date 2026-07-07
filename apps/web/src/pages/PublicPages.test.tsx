import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PricingPage } from "./PublicPages";

describe("Public pages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("shows current product copy without old widget setup language", () => {
    render(<PricingPage />);

    expect(screen.getAllByText(/agent identities/i)).not.toHaveLength(0);
    expect(screen.getByText(/OpenClaw identity linking/i)).toBeInTheDocument();
    expect(screen.queryByText(/Action Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/widget snippet/i)).not.toBeInTheDocument();
  });
});
