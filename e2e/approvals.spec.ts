import { expect, test } from "@playwright/test";
import { apiUrl, approveFirstPending, createProUserWithAgent, useApiSession } from "./helpers";

test("agent email approval reaches the UI and resolves after approval", async ({ page, request }) => {
  const created = await createProUserWithAgent(request);
  const pending = request.post(`${apiUrl}/api/v1/agent/email/send?wait=20`, {
    headers: { authorization: `Bearer ${created.identityToken.secret}` },
    data: { to: "casey@example.com", subject: "Approval path", text: "Please confirm." }
  });
  await useApiSession(page, request);
  await page.goto("/approvals");
  await expect(page.getByText("Send email to casey@example.com: Approval path")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  const response = await pending;
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { ok: boolean; status?: string };
  expect(body.ok).toBe(true);

  await approveFirstPending(request).catch(() => undefined);
});
