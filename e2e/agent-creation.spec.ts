import { expect, test } from "@playwright/test";
import { signupByApi, useApiSession } from "./helpers";

test("wizard reveals token once and contact points render", async ({ page, request }) => {
  await signupByApi(request);
  await useApiSession(page, request);
  await page.goto("/agents");
  await page.getByRole("button", { name: "New identity" }).click();
  await page.getByLabel("Name").fill("Browser Agent");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Phone - upgrade required")).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create identity" }).click();
  const token = page.locator(".site-onboarding-page__token code");
  await expect(token).toContainText("brk_test_");
  await page.getByRole("button", { name: "Copy" }).click();
  await page.getByRole("button", { name: /I stored it/i }).click();
  await page.getByRole("button", { name: /Browser Agent/ }).click();
  await expect(page.getByText(/browser-agent@agents\.barkan\.dev/i).first()).toBeVisible();
});
