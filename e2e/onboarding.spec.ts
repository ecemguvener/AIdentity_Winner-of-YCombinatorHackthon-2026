import { expect, test } from "@playwright/test";
import { apiUrl, signupByApi, useApiSession } from "./helpers";

test("fresh user checklist completes steps 1-4", async ({ page, request }) => {
  await signupByApi(request);
  await useApiSession(page, request);
  await page.goto("/agents/new");
  await page.getByLabel("Name").fill("Checklist Agent");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create identity" }).click();
  const tokenText = await page.locator(".site-onboarding-page__token code").innerText();
  const token = tokenText.trim();
  await page.getByRole("button", { name: /I stored it/i }).click();
  await expect(page.getByText("Get to first action")).toBeVisible();
  await request.get(`${apiUrl}/api/v1/agent/whoami`, { headers: { authorization: `Bearer ${token}` } });
  await page.reload();
  await page.getByText("Send test email").click();
  await page.goto("/approvals");
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${apiUrl}/api/auth/me`);
    const body = await response.json() as { user: { onboarding: { completedAt: string | null } } };
    return body.user.onboarding.completedAt;
  }).not.toBeNull();
});
