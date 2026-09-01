import type { ProbeResult } from "./probe-store.js";

const MS_PER_MINUTE = 60 * 1000;

/**
 * Whether anything the system believes is live is actually serving.
 *
 * Deliberately code and not an agent, for the same reason `stalePasses` is:
 * the failure this detects includes "the prober stopped running", and a pass
 * that has stopped running cannot report that it has stopped running. Read by
 * the daily digest, which runs on its own schedule.
 */
export function probeWarnings(input: {
  probes: ProbeResult[];
  /** Slugs currently declared in deploys.yaml. A declared deployment with no probe record is its own warning. */
  declaredSlugs: string[];
  now: Date;
  maxAgeMinutes: number;
}): string[] {
  const lines: string[] = [];
  const bySlug = new Map(input.probes.map((r) => [r.slug, r]));

  for (const slug of input.declaredSlugs) {
    const probe = bySlug.get(slug);
    if (!probe) {
      lines.push(`⚠️ \`${slug}\` is declared in deploys.yaml but has never been probed — the prober may not be running.`);
      continue;
    }
    const ageMinutes = (input.now.getTime() - new Date(probe.lastProbeAt).getTime()) / MS_PER_MINUTE;
    if (ageMinutes > input.maxAgeMinutes) {
      lines.push(
        `⚠️ \`${slug}\`'s last probe is ${Math.floor(ageMinutes)} minutes old — the prober has stopped running, so its liveness below is stale.`,
      );
      continue;
    }
    if (!probe.ok) {
      lines.push(
        `⚠️ \`${slug}\` is not serving at ${probe.url} — ${probe.detail ?? "no detail"} ` +
          `(${probe.consecutiveFailures} consecutive failure(s)).`,
      );
    }
  }

  return lines;
}
