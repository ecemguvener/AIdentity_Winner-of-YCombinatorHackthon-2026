# Integration E2E Harness

Run the mock-mode capability proof:

```bash
npm run e2e:integration
```

The harness boots the full Fastify app against a Mongo memory replica set, uses mock email/phone providers, drives the public SDK and MCP HTTP endpoint, and prints a per-scenario pass/fail table before exiting. It covers owner signup and provisioning, email approval/threading/reply, phone approval/post-call webhook, inbound SMS code extraction, Stripe subscription and usage dry-run reporting, and safety regressions.

CI wiring note: run `npm run e2e:integration` on pull requests after unit tests. Mock mode is the default and is expected to stay under 5 minutes.

For the mutation drill, comment out the inbound message/thread increment in the email scenario helper or the email service's thread bump. The `email loop` scenario must fail because it asserts the exact audit action chain and thread message count.

Live staging drill:

```bash
E2E_MODE=live PUBLIC_API_URL=https://aidentity.space npm run e2e:integration
```

Live mode is intentionally documented as a staging operation rather than run by the local Vitest harness. In staging, keep the same scenario order but relax assertions that require provider-controlled delivery: email checks provider acceptance and webhook receipt, not inbox content; phone places a call to a Twilio test number and asserts the post-call webhook, not a human transcript.
