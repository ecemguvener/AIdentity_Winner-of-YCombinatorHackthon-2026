import { expect, test } from "@playwright/test";
import { signupByApi, useApiSession } from "./helpers";

test("billing renders mock ops and free plan limit modal", async ({ page, request }) => {
  await signupByApi(request);
  await useApiSession(page, request);
  await page.goto("/agents");
  await page.goto("/settings/billing");
  await expect(page.getByText(/mock/i).first()).toBeVisible();
  await page.goto("/agents/new");
  await page.getByLabel("Name").fill("First Free Agent");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create identity" }).click();
  await page.getByRole("button", { name: /I stored it/i }).click();
  await page.goto("/agents/new");
  await page.getByLabel("Name").fill("Second Free Agent");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create identity" }).click();
  await expect(page.getByText(/Plan limit reached|plan limit/i)).toBeVisible();
});
