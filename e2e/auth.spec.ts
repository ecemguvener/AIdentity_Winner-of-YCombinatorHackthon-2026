import { expect, test } from "@playwright/test";
import { loginByUi, signupByApi, uniqueEmail } from "./helpers";

test("signup, logout, login, wrong password, and reload persistence", async ({ page, request }) => {
  const email = uniqueEmail("auth");
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Name this agent identity")).toBeVisible();
  await page.goto("/agents");
  await Promise.all([
    page.waitForURL("/", { waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "Sign out" }).click()
  ]);
  await page.goto("/signin");
  await expect(page.getByText("Welcome !")).toBeVisible();

  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password").fill("wrongpass");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText(/invalid email or password/i);

  await page.getByRole("button", { name: /use another email/i }).click();
  await loginByUi(page, email);
  await page.reload();
  await expect(page.getByText("Identities").or(page.getByText("Name this agent identity"))).toBeVisible();

  const seeded = await signupByApi(request);
  expect(seeded.email).toContain("e2e");
});
