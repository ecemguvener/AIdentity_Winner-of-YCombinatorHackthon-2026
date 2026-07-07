import type { Collections, PhoneNumberDocument } from "../db.js";
import { connectDatabase } from "../db.js";
import { loadConfig, type AppConfig } from "../config.js";
import { listPurchasedNumbers, type TwilioPurchasedNumberSummary } from "../providers/twilio-numbers.js";

export interface TwilioAuditRow {
  type: "ok" | "twilio_orphan" | "database_orphan";
  e164: string;
  twilioSid: string | null;
  databaseStatus: string | null;
  detail: string;
}

export async function auditTwilioNumbers(
  collections: Collections,
  config: AppConfig,
  providerNumbers?: TwilioPurchasedNumberSummary[]
): Promise<TwilioAuditRow[]> {
  const [twilioNumbers, databaseNumbers] = await Promise.all([
    providerNumbers ? Promise.resolve(providerNumbers) : listPurchasedNumbers(config),
    collections.phoneNumbers.find({ status: { $ne: "released" } }).toArray()
  ]);
  return buildTwilioAuditRows(twilioNumbers, databaseNumbers);
}

export function buildTwilioAuditRows(
  twilioNumbers: TwilioPurchasedNumberSummary[],
  databaseNumbers: PhoneNumberDocument[]
): TwilioAuditRow[] {
  const databaseBySid = new Map(databaseNumbers.filter((row) => row.twilioSid).map((row) => [row.twilioSid!, row]));
  const twilioBySid = new Map(twilioNumbers.map((number) => [number.twilioSid, number]));
  const rows: TwilioAuditRow[] = [];

  for (const twilioNumber of twilioNumbers) {
    const databaseRow = databaseBySid.get(twilioNumber.twilioSid);
    rows.push(databaseRow
      ? {
          type: "ok",
          e164: twilioNumber.e164,
          twilioSid: twilioNumber.twilioSid,
          databaseStatus: databaseRow.status,
          detail: "Twilio number has a database row"
        }
      : {
          type: "twilio_orphan",
          e164: twilioNumber.e164,
          twilioSid: twilioNumber.twilioSid,
          databaseStatus: null,
          detail: "Paid Twilio number is missing from phoneNumbers"
        });
  }

  for (const databaseRow of databaseNumbers) {
    if (!databaseRow.twilioSid || !twilioBySid.has(databaseRow.twilioSid)) {
      rows.push({
        type: "database_orphan",
        e164: databaseRow.e164,
        twilioSid: databaseRow.twilioSid ?? null,
        databaseStatus: databaseRow.status,
        detail: "phoneNumbers row has no matching Twilio number"
      });
    }
  }

  return rows.sort((left, right) => left.type.localeCompare(right.type) || left.e164.localeCompare(right.e164));
}

function printRows(rows: TwilioAuditRow[]): void {
  if (!rows.length) {
    console.log("No Twilio or database phone numbers found.");
    return;
  }
  console.table(rows.map((row) => ({
    type: row.type,
    e164: row.e164,
    twilioSid: row.twilioSid ?? "",
    databaseStatus: row.databaseStatus ?? "",
    detail: row.detail
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const database = await connectDatabase(config);
  try {
    printRows(await auditTwilioNumbers(database.collections, config));
  } finally {
    await database.client.close();
  }
}
