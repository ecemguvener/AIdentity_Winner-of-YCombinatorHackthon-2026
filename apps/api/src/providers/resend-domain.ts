import { Resend, type DomainRecords } from "resend";
import type { AppConfig } from "../config.js";

interface ResendDomainRecordStatus {
  record: string;
  type: string;
  name: string;
  value: string;
  status: string;
  priority?: number;
}

export interface ResendAgentDomainStatus {
  id: string | null;
  name: string;
  status: string;
  verified: boolean;
  records: ResendDomainRecordStatus[];
}

export interface ResendDomainsClient {
  domains: {
    create(input: { name: string; capabilities?: { sending?: "enabled"; receiving?: "enabled" } }): Promise<{ data: { id: string; name: string; status: string; records?: DomainRecords[] } | null; error: { message: string } | null }>;
    list(): Promise<{ data: { data: Array<{ id: string; name: string; status: string }> } | null; error: { message: string } | null }>;
    get(id: string): Promise<{ data: { id: string; name: string; status: string; records?: DomainRecords[] } | null; error: { message: string } | null }>;
    verify(id: string): Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

let cachedStatus: { expiresAt: number; status: ResendAgentDomainStatus } | null = null;
const cacheTtlMs = 5 * 60_000;

export async function ensureAgentDomain(
  config: AppConfig,
  client: ResendDomainsClient = new Resend(config.RESEND_API_KEY)
): Promise<ResendAgentDomainStatus> {
  const existing = await findDomain(config.EMAIL_AGENT_DOMAIN, client);
  const domain = existing ?? await createDomain(config.EMAIL_AGENT_DOMAIN, client);
  if (domain.status !== "verified") {
    await client.domains.verify(domain.id).catch(() => undefined);
  }
  const status = await getDomainStatus(config, client, true);
  return status.id ? status : getStatusFromDomain(config.EMAIL_AGENT_DOMAIN, domain);
}

export async function getDomainStatus(
  config: AppConfig,
  client: ResendDomainsClient = new Resend(config.RESEND_API_KEY),
  bypassCache = false
): Promise<ResendAgentDomainStatus> {
  if (!bypassCache && cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return cachedStatus.status;
  }
  const domain = await findDomain(config.EMAIL_AGENT_DOMAIN, client);
  const status = domain ? getStatusFromDomain(config.EMAIL_AGENT_DOMAIN, domain) : missingStatus(config.EMAIL_AGENT_DOMAIN);
  cachedStatus = { expiresAt: Date.now() + cacheTtlMs, status };
  return status;
}

async function findDomain(name: string, client: ResendDomainsClient) {
  const list = await client.domains.list();
  if (list.error) throw new Error(list.error.message);
  const listed = list.data?.data.find((domain) => domain.name === name);
  if (!listed) return null;
  const detail = await client.domains.get(listed.id);
  if (detail.error) throw new Error(detail.error.message);
  return detail.data;
}

async function createDomain(name: string, client: ResendDomainsClient) {
  const created = await client.domains.create({
    name,
    capabilities: { sending: "enabled", receiving: "enabled" }
  });
  if (created.error || !created.data) {
    throw new Error(created.error?.message ?? "could not create Resend domain");
  }
  return created.data;
}

function getStatusFromDomain(name: string, domain: { id: string; status: string; records?: DomainRecords[] }): ResendAgentDomainStatus {
  return {
    id: domain.id,
    name,
    status: domain.status,
    verified: domain.status === "verified",
    records: (domain.records ?? []).map((record) => ({
      record: record.record,
      type: record.type,
      name: record.name,
      value: record.value,
      status: record.status,
      ...("priority" in record ? { priority: record.priority } : {})
    }))
  };
}

function missingStatus(name: string): ResendAgentDomainStatus {
  return { id: null, name, status: "not_created", verified: false, records: [] };
}
