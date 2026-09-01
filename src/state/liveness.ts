const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the system's periodic self-assessment is actually still happening.
 *
 * Deliberately code and not an agent: the failure this detects is "the
 * scheduled pass stopped running", and an agent that has stopped running
 * cannot report that it has stopped running. Read by the daily digest, which
 * runs on its own schedule and so survives the weekly ones dying.
 */
export function stalePasses(input: { latestMetricsAt: string | null; now: Date; maxAgeDays: number }): string[] {
  if (input.latestMetricsAt === null) {
    return ["⚠️ No metrics snapshot has ever been written — the weekly metrics pass has never completed."];
  }
  const ageDays = (input.now.getTime() - new Date(input.latestMetricsAt).getTime()) / DAY_MS;
  if (ageDays > input.maxAgeDays) {
    return [`⚠️ The newest metrics snapshot is ${Math.floor(ageDays)} days old — the weekly metrics pass has stopped running.`];
  }
  return [];
}
