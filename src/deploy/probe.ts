import type { Deployment } from "./deploys-schema.js";
import type { ProbeResult } from "./probe-store.js";

export type UrlProbe = (url: string) => Promise<{ ok: boolean; detail: string | null }>;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The real probe: an ordinary outbound request to the deployment's public URL,
 * exactly as a customer would make it — through Caddy, over the internet, with
 * TLS verified. Deliberately NOT the product's own Docker HEALTHCHECK, which
 * is written by the same agent that wrote the app and so cannot gate its own
 * rollback. See the deploy-path design §5.
 */
export const httpProbe: UrlProbe = async (url) => {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.status >= 200 && response.status < 400) return { ok: true, detail: null };
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
};

export function urlFor(deployment: Deployment): string {
  return `https://${deployment.hostname}/`;
}

/**
 * Probes every declared deployment and returns the complete next state.
 * Records for deployments no longer declared are dropped rather than kept:
 * this file describes what is declared now, and a record for something nobody
 * deploys any more is exactly the stale liveness data this whole task exists
 * to prevent.
 */
export async function runProbePass(opts: {
  deployments: Deployment[];
  previous: ProbeResult[];
  probe: UrlProbe;
  now: Date;
}): Promise<ProbeResult[]> {
  const previousBySlug = new Map(opts.previous.map((r) => [r.slug, r]));
  const lastProbeAt = opts.now.toISOString();

  return Promise.all(
    opts.deployments.map(async (deployment) => {
      const url = urlFor(deployment);
      // A probe that throws rather than resolving is still just a failure —
      // one unreachable host must never abort the pass and leave every other
      // deployment's record frozen at its last value.
      const outcome = await opts.probe(url).catch((error: unknown) => ({ ok: false, detail: (error as Error).message }));
      const priorFailures = previousBySlug.get(deployment.slug)?.consecutiveFailures ?? 0;
      return {
        slug: deployment.slug,
        url,
        lastProbeAt,
        ok: outcome.ok,
        consecutiveFailures: outcome.ok ? 0 : priorFailures + 1,
        detail: outcome.ok ? null : outcome.detail,
      };
    }),
  );
}
