import { describe, expect, it } from "vitest";
import { evaluatePurchaseRequest } from "./payments.js";

const basePolicy = {
  agentId: "agent_test",
  maxTransactionAmount: 50,
  dailyLimit: 100,
  monthlyLimit: 500,
  approvalRequiredAbove: 25,
  allowedMerchants: [] as string[],
  blockedMerchants: ["CryptoExchange"],
  blockedCategories: ["gambling", "crypto"],
  allowRecurring: false,
  createdAt: new Date(),
  updatedAt: new Date()
};

describe("evaluatePurchaseRequest", () => {
  it("auto-approves a small purchase within all limits", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 15 }, basePolicy, 0, 0);
    expect(decision.status).toBe("approved");
  });

  it("requires approval above the approval threshold", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "Amazon", amount: 40 }, basePolicy, 0, 0);
    expect(decision.status).toBe("requires_approval");
    expect(decision.reason).toBe("Amount requires human approval");
  });

  it("rejects a blocked merchant", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "CryptoExchange", amount: 10 }, basePolicy, 0, 0);
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toBe("Merchant is blocked");
  });

  it("rejects amounts above the per-transaction maximum", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "Amazon", amount: 75 }, basePolicy, 0, 0);
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toBe("Above max transaction amount");
  });

  it("rejects when the daily limit would be exceeded", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "Amazon", amount: 20 }, basePolicy, 90, 90);
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toBe("Above daily spending limit");
  });

  it("requires approval when the merchant is not on a non-empty allow list", () => {
    const decision = evaluatePurchaseRequest(
      { merchantName: "Amazon", amount: 5 },
      { ...basePolicy, allowedMerchants: ["OpenAI"] },
      0,
      0
    );
    expect(decision.status).toBe("requires_approval");
    expect(decision.reason).toBe("Merchant not on allowed list");
  });

  it("requires approval when no policy is configured", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 5 }, null, 0, 0);
    expect(decision.status).toBe("requires_approval");
    expect(decision.reason).toBe("No payment policy configured");
  });

  it("rejects blocked categories and disallowed recurring payments", () => {
    expect(
      evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 5, category: "crypto" }, basePolicy, 0, 0).status
    ).toBe("rejected");
    expect(
      evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 5, recurring: true }, basePolicy, 0, 0).status
    ).toBe("rejected");
  });
});
