import type { Db } from "mongodb";
import type { Collections } from "../db.js";

export interface MigrationContext {
  collections: Collections;
  database: Db;
  dryRun: boolean;
}

export interface MigrationResult {
  stats: Record<string, number>;
  summary: string;
}
