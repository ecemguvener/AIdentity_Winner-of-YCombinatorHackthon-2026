model: gpt 5.5

# Task 050 — `@barkan/sdk`: typed Node client

## Depends on
045 (openapi.json committed)

## Context
Developers embedding Barkan into custom agents need a typed client rather than hand-rolled fetch. The OpenAPI spec (task 045) is the contract source. Keep it lean: generated types + a small hand-written ergonomic layer (generated clients age badly; generated *types* don't).

## Objective
Publishable `packages/sdk` with full type coverage of the agent-facing API and ergonomic helpers.

## Spec
- `packages/sdk` (`@barkan/sdk`): 
  - `npm run generate` → `openapi-typescript docs/api/openapi.json -o src/generated/api.d.ts` (committed).
  - Hand-written surface:
    ```ts
    const barkan = new Barkan({ apiUrl?, token });   // token from arg or BARKAN_IDENTITY_TOKEN
    barkan.whoami()
    barkan.email.send({to, subject, text, waitForApproval?}) / .threads.list/.get / .reply
    barkan.phone.call({to, task, ...}) / .calls.list/.get / .waitForCompletion(callId, {timeoutMs})  // polls
    barkan.sms.send / .conversation / .latestCode({from?, sinceMinutes?})
    barkan.approvals.get / .waitFor(approvalId, {timeoutMs})   // poll wrapper
    barkan.audit.recent()
    ```
  - Error class `BarkanError { code, message, requestId, status }` mapped from the task-008 envelope; `ApprovalPendingError` carrying `approvalId` when wait times out.
  - Retries: idempotent GETs ×2 on 5xx/network; never auto-retry POSTs (money).
  - Zero runtime deps beyond `undici`-compatible global fetch (Node 18+); ESM + CJS builds (tsup); README with quickstart.
- Contract sync gate: CI test spins the API (mock providers, memory Mongo), runs the SDK against it for every method, and fails if `openapi.json` changed without regeneration (hash check).

## Implementation steps
1. Scaffold package + generation + client implementation.
2. Test suite against in-process API (reuse test harness from contract suites) — every method, error mapping, both wait helpers, retry behavior (fake 500 once → succeeds).
3. Example `examples/simple-agent.ts`: LLM-free scripted agent that emails, then fetches an SMS code — runnable against local dev.
4. Wire root build/test; add publish config (`private: false`, `files`, `exports`).

## Acceptance criteria
- `examples/simple-agent.ts` runs green against local API in mock mode.
- SDK types drift test fails when a contract snapshot changes without regen (simulate in test).
- Package builds ESM+CJS, `npm pack` output < 200kB.

## How to test
```bash
npm --workspace @barkan/sdk run generate && npm --workspace @barkan/sdk run build && npm --workspace @barkan/sdk run test
node packages/sdk/dist/examples/simple-agent.js   # or tsx examples/simple-agent.ts
```
