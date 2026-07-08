import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { connectDatabase } from "../db.js";
import type { MigrationContext, MigrationResult } from "./types.js";

interface MigrationModule {
  name: string;
  run(context: MigrationContext): Promise<MigrationResult>;
}

// Executes every migration file in this directory in filename order.
// Migrations are idempotent, so they always run; each real run upserts a
// completion record into the `migrations` collection.
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const database = await connectDatabase(config);
  const migrationsDir = path.dirname(fileURLToPath(import.meta.url));
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => /^\d{4}-.*\.(ts|js)$/.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
    .sort();

  try {
    for (const migrationFile of migrationFiles) {
      const migrationUrl = pathToFileURL(path.join(migrationsDir, migrationFile)).href;
      const migration = (await import(migrationUrl)) as MigrationModule;
      const { stats, summary } = await migration.run({ collections: database.collections, database: database.db, dryRun });
      console.log(`[migrate] ${migration.name}${dryRun ? " (dry-run)" : ""}: ${summary}`);
      if (!dryRun) {
        const now = new Date();
        await database.collections.migrations.updateOne(
          { name: migration.name },
          {
            $set: { ranAt: now, stats, updatedAt: now },
            $setOnInsert: { createdAt: now }
          },
          { upsert: true }
        );
      }
    }
  } finally {
    await database.client.close();
  }
}

main().catch((error) => {
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
});
