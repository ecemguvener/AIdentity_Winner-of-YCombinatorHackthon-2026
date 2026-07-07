import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Collections } from "./db.js";
import { ApiError } from "./errors.js";

type Labels = Record<string, string>;
type ProviderOutcome = "success" | "error";

const httpBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const providerBuckets = httpBuckets;
const providerSamples: Array<{ provider: string; outcome: ProviderOutcome; at: number }> = [];

export function registerMetricsHooks(app: FastifyInstance, collections: Collections): void {
  app.addHook("onRequest", async (request) => {
    (request as { metricsStartedAt?: bigint }).metricsStartedAt = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = (request as { metricsStartedAt?: bigint }).metricsStartedAt;
    if (!startedAt) {
      return;
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    httpDurations.observe(durationMs, {
      route: request.routeOptions.url ?? normalizeRoute(request.url),
      method: request.method,
      status: String(reply.statusCode)
    });
  });

  app.get("/internal/metrics", async (request) => {
    if (!isInternalRequest(request)) {
      throw new ApiError(403, "forbidden", "internal route");
    }
    return renderMetrics(collections);
  });
}

export async function renderMetrics(collections: Collections): Promise<string> {
  const pendingApprovals = await collections.approvals.countDocuments({ status: "pending" });
  const sseConnections = getSseConnectionGauge();
  return [
    httpDurations.render(),
    providerDurations.render(),
    webhookEvents.render(),
    "# HELP approvals_pending Pending owner approvals",
    "# TYPE approvals_pending gauge",
    `approvals_pending ${pendingApprovals}`,
    "# HELP sse_connections Active server-sent event connections",
    "# TYPE sse_connections gauge",
    `sse_connections ${sseConnections}`,
    ""
  ].join("\n");
}

export async function instrumentProviderCall<T>(
  provider: string,
  operation: string,
  call: () => Promise<T>
): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await call();
    observeProvider(provider, operation, "success", startedAt);
    return result;
  } catch (error) {
    observeProvider(provider, operation, "error", startedAt);
    throw error;
  }
}

export function recordWebhookEventMetric(provider: string, status: string): void {
  webhookEvents.inc({ provider, status });
}

export function providerErrorRates(windowMs: number, now = Date.now()): Array<{ provider: string; total: number; errors: number; rate: number }> {
  const recent = providerSamples.filter((sample) => now - sample.at <= windowMs);
  const providers = new Set(recent.map((sample) => sample.provider));
  return [...providers].map((provider) => {
    const samples = recent.filter((sample) => sample.provider === provider);
    const errors = samples.filter((sample) => sample.outcome === "error").length;
    return { provider, total: samples.length, errors, rate: samples.length ? errors / samples.length : 0 };
  });
}

export function resetMetricsForTest(): void {
  httpDurations.clear();
  providerDurations.clear();
  webhookEvents.clear();
  providerSamples.length = 0;
}

function observeProvider(provider: string, operation: string, outcome: ProviderOutcome, startedAt: bigint): void {
  providerDurations.observe(Number(process.hrtime.bigint() - startedAt) / 1_000_000, { provider, operation, outcome });
  providerSamples.push({ provider, outcome, at: Date.now() });
  if (providerSamples.length > 1000) {
    providerSamples.splice(0, providerSamples.length - 1000);
  }
}

class Counter {
  private readonly values = new Map<string, number>();

  constructor(private readonly name: string, private readonly help: string, private readonly labelNames: string[]) {}

  inc(labels: Labels, value = 1): void {
    const key = labelKey(labels, this.labelNames);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  render(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values.entries()].map(([key, value]) => `${this.name}${key} ${value}`)
    ].join("\n");
  }

  clear(): void {
    this.values.clear();
  }
}

class Histogram {
  private readonly values = new Map<string, { buckets: number[]; count: number; sum: number }>();

  constructor(private readonly name: string, private readonly help: string, private readonly labelNames: string[], private readonly buckets: number[]) {}

  observe(value: number, labels: Labels): void {
    const key = labelKey(labels, this.labelNames);
    const entry = this.values.get(key) ?? { buckets: this.buckets.map(() => 0), count: 0, sum: 0 };
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]!) {
        entry.buckets[index] += 1;
      }
    }
    entry.count += 1;
    entry.sum += value;
    this.values.set(key, entry);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.values.entries()) {
      const labels = parseLabelKey(key);
      for (let index = 0; index < this.buckets.length; index += 1) {
        lines.push(`${this.name}_bucket${labelKey({ ...labels, le: String(this.buckets[index]) }, [...this.labelNames, "le"])} ${entry.buckets[index]}`);
      }
      lines.push(`${this.name}_bucket${labelKey({ ...labels, le: "+Inf" }, [...this.labelNames, "le"])} ${entry.count}`);
      lines.push(`${this.name}_sum${key} ${entry.sum}`);
      lines.push(`${this.name}_count${key} ${entry.count}`);
    }
    return lines.join("\n");
  }

  clear(): void {
    this.values.clear();
  }
}

const httpDurations = new Histogram("http_request_duration_ms", "HTTP request duration in milliseconds", ["route", "method", "status"], httpBuckets);
const providerDurations = new Histogram("provider_call_duration_ms", "Provider call duration in milliseconds", ["provider", "operation", "outcome"], providerBuckets);
const webhookEvents = new Counter("webhook_events_total", "Webhook events by provider and final status", ["provider", "status"]);

function labelKey(labels: Labels, labelNames: string[]): string {
  return `{${labelNames.map((name) => `${name}="${escapeLabel(labels[name] ?? "")}"`).join(",")}}`;
}

function parseLabelKey(key: string): Labels {
  const labels: Labels = {};
  for (const match of key.matchAll(/(\w+)="([^"]*)"/g)) {
    labels[match[1]!] = match[2]!;
  }
  return labels;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isInternalRequest(request: FastifyRequest): boolean {
  const ip = request.ip.replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function normalizeRoute(url: string): string {
  return (url.split("?")[0] ?? url).replace(/[a-f0-9]{24}/gi, ":id");
}

function getSseConnectionGauge(): number {
  const approvalsModule = globalThis as typeof globalThis & { __barkanSseConnections?: number };
  return approvalsModule.__barkanSseConnections ?? 0;
}
