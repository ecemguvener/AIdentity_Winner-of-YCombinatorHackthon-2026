import type { Document } from "mongodb";
import type { MigrationContext, MigrationResult } from "./types.js";

export const name = "2026-08-drop-old-identity-collections";

const OLD_COLLECTIONS = ["sites", ["atlas", "Projects"].join(""), "apiKeys", "interactionLogs"] as const;
const ARCHIVE_PREFIX = "old_identity_archive_2026_08";

export async function run(context: MigrationContext): Promise<MigrationResult> {
  const stats: Record<string, number> = {
    collectionsChecked: OLD_COLLECTIONS.length,
    collectionsPresent: 0,
    documentsArchived: 0,
    collectionsDropped: 0
  };
  const archivedCollections: string[] = [];

  const existingCollections = new Set(
    (await context.database.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name)
  );

  for (const collectionName of OLD_COLLECTIONS) {
    if (!existingCollections.has(collectionName)) {
      continue;
    }

    stats.collectionsPresent += 1;
    const source = context.database.collection<Document>(collectionName);
    const documentCount = await source.countDocuments();
    stats[`${collectionName}Documents`] = documentCount;

    if (context.dryRun) {
      continue;
    }

    if (documentCount > 0) {
      const archiveName = `${ARCHIVE_PREFIX}_${collectionName}`;
      await context.database.collection<Document>(archiveName).deleteMany({});
      await source.aggregate([{ $match: {} }, { $out: archiveName }]).toArray();
      archivedCollections.push(archiveName);
      stats.documentsArchived += documentCount;
    }

    await source.drop();
    stats.collectionsDropped += 1;
  }

  const summary =
    stats.collectionsPresent === 0
      ? "no removed identity collections found"
      : context.dryRun
        ? `would archive and drop ${stats.collectionsPresent} removed identity collections`
        : `archived ${stats.documentsArchived} docs into ${archivedCollections.join(", ") || "empty archives"} and dropped ${stats.collectionsDropped} collections`;

  return { stats, summary };
}
