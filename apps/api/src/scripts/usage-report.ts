import { loadConfig } from "../config.js";
import { connectDatabase } from "../db.js";
import { reportUsageToStripe } from "../usage.js";

const dryRun = process.argv.includes("--dry-run");
const config = loadConfig();
const database = await connectDatabase(config);

try {
  const reports = await reportUsageToStripe(database.collections, config, { dryRun });
  if (reports.length === 0) {
    console.log("No usage overage to report.");
  } else {
    for (const report of reports) {
      console.log(`${report.ownerUserId} ${report.periodKey} ${report.meter} +${report.delta} ${report.identifier}${dryRun ? " dry-run" : ""}`);
    }
  }
} finally {
  await database.client.close();
}
