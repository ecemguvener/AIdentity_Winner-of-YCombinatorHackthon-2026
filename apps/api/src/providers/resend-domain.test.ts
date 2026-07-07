import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { ensureAgentDomain, getDomainStatus, type ResendDomainsClient } from "./resend-domain.js";

const config = {
  RESEND_API_KEY: "re_test",
  EMAIL_AGENT_DOMAIN: "agents.example.com"
} as AppConfig;

describe("resend domain provider", () => {
  it("creates the agent domain with sending and receiving enabled", async () => {
    const calls: string[] = [];
    let wasCreated = false;
    const client: ResendDomainsClient = {
      domains: {
        list: async () => ({
          data: { data: wasCreated ? [{ id: "domain_1", name: config.EMAIL_AGENT_DOMAIN, status: "pending" }] : [] },
          error: null
        }),
        create: async (input) => {
          wasCreated = true;
          calls.push(`${input.name}:${input.capabilities?.sending}:${input.capabilities?.receiving}`);
          return { data: { id: "domain_1", name: input.name, status: "pending", records: [] }, error: null };
        },
        get: async () => ({ data: { id: "domain_1", name: config.EMAIL_AGENT_DOMAIN, status: "verified", records: [] }, error: null }),
        verify: async () => ({ data: { id: "domain_1" }, error: null })
      }
    };

    const status = await ensureAgentDomain(config, client);

    expect(calls).toEqual(["agents.example.com:enabled:enabled"]);
    expect(status.verified).toBe(true);
  });

  it("returns DNS records from an existing domain", async () => {
    const client: ResendDomainsClient = {
      domains: {
        list: async () => ({ data: { data: [{ id: "domain_1", name: config.EMAIL_AGENT_DOMAIN, status: "pending" }] }, error: null }),
        create: async () => { throw new Error("should not create"); },
        get: async () => ({
          data: {
            id: "domain_1",
            name: config.EMAIL_AGENT_DOMAIN,
            status: "pending",
            records: [{ record: "SPF", type: "TXT", name: "agents", value: "v=spf1 include:amazonses.com ~all", ttl: "Auto", status: "pending" }]
          },
          error: null
        }),
        verify: async () => ({ data: { id: "domain_1" }, error: null })
      }
    };

    const status = await getDomainStatus(config, client, true);

    expect(status.records[0]).toMatchObject({ record: "SPF", type: "TXT", status: "pending" });
  });
});
