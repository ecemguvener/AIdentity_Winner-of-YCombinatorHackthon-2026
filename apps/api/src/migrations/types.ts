import type { Collections } from "../db.js";

export interface MigrationContext {
  collections: Collections;
  dryRun: boolean;
}

export interface MigrationResult {
  stats: Record<string, number>;
  summary: string;
}
