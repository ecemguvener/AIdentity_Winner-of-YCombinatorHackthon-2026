import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthScreen } from "./AuthPage";

describe("Auth page", () => {
  it("renders email gate without crashing", () => {
    render(<AuthScreen onAuthed={vi.fn()} onReady={async () => undefined} />);

    expect(screen.getByRole("heading", { name: /welcome/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });
});
