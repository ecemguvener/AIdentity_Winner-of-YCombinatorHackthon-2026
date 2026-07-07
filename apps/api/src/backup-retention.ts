const backupNamePattern = /^barkan-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.archive\.gz$/;

export function archivesToPrune(fileNames: string[], dailyRetain = 7, weeklyRetain = 4): string[] {
  const archives = fileNames
    .map((name) => ({ name, date: parseBackupDate(name) }))
    .filter((item): item is { name: string; date: Date } => Boolean(item.date))
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const keep = new Set<string>();
  for (const archive of archives.slice(0, dailyRetain)) {
    keep.add(archive.name);
  }

  const weeklyBuckets = new Set<string>();
  for (const archive of archives.slice(dailyRetain)) {
    const week = isoWeekKey(archive.date);
    if (weeklyBuckets.size < weeklyRetain && !weeklyBuckets.has(week)) {
      weeklyBuckets.add(week);
      keep.add(archive.name);
    }
  }

  return archives.map((archive) => archive.name).filter((name) => !keep.has(name));
}

function parseBackupDate(name: string): Date | null {
  const match = backupNamePattern.exec(name);
  if (!match) {
    return null;
  }
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
}

function isoWeekKey(date: Date): string {
  const work = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = work.getUTCDay() || 7;
  work.setUTCDate(work.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(work.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((work.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${work.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}
