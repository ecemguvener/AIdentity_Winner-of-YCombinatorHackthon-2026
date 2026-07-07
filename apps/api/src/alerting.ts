import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { captureOperationalAlert } from "./sentry.js";
import { providerErrorRates } from "./metrics.js";

const fiveMinutesMs = 5 * 60 * 1000;
const oldApprovalMs = 55 * 60 * 1000;
const dedupeMs = 60 * 1000;
const lastAlerts = new Map<string, number>();

export interface AlertRecord {
  key: string;
  message: string;
  detail: Record<string, unknown>;
}

export async function evaluateAlertRules(
  collections: Collections,
  config: AppConfig,
  now = new Date()
): Promise<AlertRecord[]> {
  const alerts: AlertRecord[] = [];
  const since = new Date(now.getTime() - fiveMinutesMs);
  const failedWebhookCount = await collections.webhookEvents.countDocuments({ status: "failed", updatedAt: { $gte: since } });
  if (failedWebhookCount > 0) {
    alerts.push({
      key: "webhook.failed",
      message: "failed webhook deliveries in the last 5 minutes",
      detail: { failedWebhookCount }
    });
  }

  for (const rate of providerErrorRates(fiveMinutesMs, now.getTime())) {
    if (rate.total >= 5 && rate.rate > 0.2) {
      alerts.push({
        key: `provider.${rate.provider}.error_rate`,
        message: `${rate.provider} provider error rate above 20%`,
        detail: rate
      });
    }
  }

  const pendingSince = new Date(now.getTime() - oldApprovalMs);
  const oldPendingApprovals = await collections.approvals.countDocuments({ status: "pending", createdAt: { $lte: pendingSince } });
  if (oldPendingApprovals > 0) {
    alerts.push({
      key: "approvals.pending_old",
      message: "pending approvals older than 55 minutes",
      detail: { oldPendingApprovals }
    });
  }

  for (const alert of alerts) {
    await emitAlert(alert, config, now);
  }

  return alerts;
}

export function startAlertingLoop(collections: Collections, config: AppConfig): NodeJS.Timeout | null {
  if (config.NODE_ENV === "test") {
    return null;
  }
  return setInterval(() => {
    void evaluateAlertRules(collections, config).catch((error) => {
      captureOperationalAlert("alert evaluation failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, 60_000).unref();
}

async function emitAlert(alert: AlertRecord, config: AppConfig, now: Date): Promise<void> {
  const lastSeenAt = lastAlerts.get(alert.key) ?? 0;
  if (now.getTime() - lastSeenAt < dedupeMs) {
    return;
  }
  lastAlerts.set(alert.key, now.getTime());
  captureOperationalAlert(alert.message, alert.detail);
  if (config.ALERT_WEBHOOK_URL) {
    await fetch(config.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: alert.message, key: alert.key, detail: alert.detail })
    }).catch(() => undefined);
  }
}
