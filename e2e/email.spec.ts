import { expect, test } from "@playwright/test";
import { apiUrl, createProUserWithAgent, useApiSession } from "./helpers";

test("synthetic inbound email appears and owner reply creates outbound row", async ({ page, request }) => {
  const created = await createProUserWithAgent(request);
  await useApiSession(page, request);
  await page.goto(`/agents/${created.agent.id}?tab=email`);
  await expect(page.getByText(created.agent.emailAddress!)).toBeVisible();
  const inbound = await page.request.post(`${apiUrl}/api/test-support/inbound-email`, {
    data: { agentId: created.agent.id, from: "sender@example.com", subject: "Inbound hello", text: "First inbound body" }
  });
  expect(inbound.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByText("Inbound hello").first()).toBeVisible();
  await page.getByText("Inbound hello").first().click();
  await page.getByLabel("Reply").fill("Thanks, received.");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByText(/approval required/i)).toBeVisible();
});
