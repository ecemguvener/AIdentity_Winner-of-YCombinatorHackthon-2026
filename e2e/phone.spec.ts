import { expect, test } from "@playwright/test";
import { apiUrl, approveFirstPending, createProUserWithAgent, useApiSession } from "./helpers";

test("owner test call appears and transcript renders after synthetic post-call", async ({ page, request }) => {
  const created = await createProUserWithAgent(request, { phone: true });
  await useApiSession(page, request);
  await page.goto(`/agents/${created.agent.id}?tab=phone`);
  await page.getByRole("button", { name: "Test call me" }).click();
  await page.getByLabel("Your phone number").fill("+14155550198");
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await approveFirstPending(page.request);
  await page.reload();
  const calls = await page.request.get(`${apiUrl}/api/v1/agents/${created.agent.id}/phone/calls`);
  const callId = ((await calls.json()) as { calls: Array<{ id: string }> }).calls[0]!.id;
  await page.request.post(`${apiUrl}/api/test-support/post-call`, { data: { callId } });
  await page.reload();
  await expect(page.getByText("Confirmed, this works for me.")).toBeVisible();
});
