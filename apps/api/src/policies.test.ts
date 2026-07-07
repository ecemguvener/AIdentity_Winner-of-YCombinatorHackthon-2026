import { describe, expect, it } from "vitest";
import { defaultEmailPolicy, normalizeEmailPolicy, recipientPatternMatches } from "./policies.js";

describe("email policy helpers", () => {
  it("defaults requireApproval from agent mode", () => {
    expect(defaultEmailPolicy("always").requireApproval).toBe("always");
    expect(defaultEmailPolicy("policy").requireApproval).toBe("new_recipients");
    expect(defaultEmailPolicy("autonomous").requireApproval).toBe("new_recipients");
  });

  it("matches exact recipients case-insensitively", () => {
    expect(recipientPatternMatches("Alice@Example.com", "alice@example.com")).toBe(true);
    expect(recipientPatternMatches("alice@example.com", "bob@example.com")).toBe(false);
  });

  it("matches domain patterns without matching subdomains", () => {
    expect(recipientPatternMatches("alice@example.com", "@example.com")).toBe(true);
    expect(recipientPatternMatches("alice@mail.example.com", "@example.com")).toBe(false);
  });

  it("normalizes recipient lists and fills numeric defaults", () => {
    expect(normalizeEmailPolicy({ allowedRecipients: [" ALICE@EXAMPLE.COM ", "alice@example.com"] }, "policy")).toMatchObject({
      requireApproval: "new_recipients",
      allowedRecipients: ["alice@example.com"],
      dailySendLimit: 50,
      maxRecipientsPerMessage: 5
    });
  });
});
