import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { validateEnvFile } from "./check-env.mjs";

test("production env check catches removed live keys", () => {
  const filePath = writeEnv(`
NODE_ENV=production
API_PORT=4000
PUBLIC_APP_URL=https://barkan.dev
PUBLIC_API_URL=https://api.barkan.dev
MONGODB_URI=mongodb://127.0.0.1:27017/barkan-prod
SESSION_COOKIE_NAME=barkan_session
SESSION_SECRET=replace-with-a-long-random-secret
API_RATE_LIMIT_MAX=300
ACCOUNT_EXPORT_DIR=/tmp/barkan-account-exports
PROVIDER_MODE_EMAIL=live
PROVIDER_MODE_PHONE=live
`);

  const result = validateEnvFile({ target: "production", filePath });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /STRIPE_SECRET_KEY/);
  assert.match(result.errors.join("\n"), /TWILIO_AUTH_TOKEN/);
});

test("staging env check accepts mock providers and non-prod database", () => {
  const filePath = writeEnv(`
NODE_ENV=staging
API_PORT=4002
PUBLIC_APP_URL=https://staging.barkan.dev
PUBLIC_API_URL=https://staging-api.barkan.dev
MONGODB_URI=mongodb://127.0.0.1:27017/barkan-staging
SESSION_COOKIE_NAME=barkan_session
SESSION_SECRET=replace-with-a-long-random-secret
API_RATE_LIMIT_MAX=300
ACCOUNT_EXPORT_DIR=/tmp/barkan-account-exports
PROVIDER_MODE_EMAIL=mock
PROVIDER_MODE_PHONE=mock
`);

  const result = validateEnvFile({ target: "staging", filePath });

  assert.equal(result.ok, true, result.errors.join("\n"));
});

function writeEnv(content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "barkan-env-"));
  const filePath = path.join(directory, ".env");
  fs.writeFileSync(filePath, content.trimStart());
  return filePath;
}
