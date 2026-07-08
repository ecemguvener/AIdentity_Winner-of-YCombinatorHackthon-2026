import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const apiUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4101";

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

export async function signupByApi(request: APIRequestContext, email = uniqueEmail("e2e")) {
  const response = await request.post(`${apiUrl}/api/auth/signup`, {
    data: { email, password: "password123" }
  });
  expect(response.ok()).toBeTruthy();
  return { email, password: "password123" };
}

export async function loginByUi(page: Page, email: string, password = "password123") {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Name this agent identity").or(page.getByRole("heading", { name: "Agent identities" }))).toBeVisible();
}

export async function useApiSession(page: Page, request: APIRequestContext) {
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
  await page.goto("/agents");
  await expect(page.getByText("Name this agent identity").or(page.getByRole("heading", { name: "Agent identities" }))).toBeVisible();
}

async function createAgentByApi(request: APIRequestContext, input: { name?: string; phone?: boolean } = {}) {
  const response = await request.post(`${apiUrl}/api/v1/agents`, {
    data: {
      name: input.name ?? "E2E Agent",
      runtime: "openclaw",
      capabilities: { email: true, phone: input.phone ?? false },
      approvalMode: "always"
    }
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as {
    agent: { id: string; emailAddress: string | null; phoneE164: string | null };
    identityToken: { secret: string; prefix: string };
  };
}

export async function createProUserWithAgent(request: APIRequestContext, options: { phone?: boolean } = {}) {
  const user = await signupByApi(request);
  const billing = await request.post(`${apiUrl}/api/test-support/billing-plan`, { data: { plan: "pro" } });
  expect(billing.ok()).toBeTruthy();
  const created = await createAgentByApi(request, { phone: options.phone });
  return { ...user, ...created };
}

export async function approveFirstPending(request: APIRequestContext) {
  const approvalId = await waitForFirstPendingApproval(request);
  const response = await request.post(`${apiUrl}/api/v1/approvals/${approvalId}/approve`, { data: {} });
  expect(response.ok()).toBeTruthy();
  return approvalId;
}

async function waitForFirstPendingApproval(request: APIRequestContext): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = await request.get(`${apiUrl}/api/v1/approvals`);
    expect(list.ok()).toBeTruthy();
    const body = await list.json() as { approvals: Array<{ id: string }> };
    if (body.approvals[0]) return body.approvals[0].id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("pending approval not found");
}
