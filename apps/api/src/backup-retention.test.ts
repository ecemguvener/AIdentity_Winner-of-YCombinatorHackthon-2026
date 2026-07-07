import { describe, expect, it } from "vitest";
import { archivesToPrune } from "./backup-retention.js";

describe("backup archive retention", () => {
  it("keeps seven latest dailies plus four weekly representatives", () => {
    const files = Array.from({ length: 20 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return `barkan-2026-01-${day}T030000Z.archive.gz`;
    });

    const pruned = archivesToPrune(files, 7, 4);

    expect(pruned).toHaveLength(10);
    expect(pruned).not.toContain("barkan-2026-01-20T030000Z.archive.gz");
    expect(pruned).not.toContain("barkan-2026-01-14T030000Z.archive.gz");
  });
});
