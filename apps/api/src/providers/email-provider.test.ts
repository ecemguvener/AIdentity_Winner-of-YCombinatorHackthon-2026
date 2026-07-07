import { describe, expect, it } from "vitest";
import { MockEmailProvider } from "./email-provider.js";

describe("email providers", () => {
  it("mock provider records sends and returns a mock provider id", async () => {
    const provider = new MockEmailProvider();

    const result = await provider.sendEmail({
      from: "\"Maya\" <maya@agents.barkan.dev>",
      to: "person@example.com",
      subject: "Hello",
      text: "Hi"
    });

    expect(result.providerMessageId).toMatch(/^mock_/);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ to: "person@example.com", subject: "Hello" });
  });
});
