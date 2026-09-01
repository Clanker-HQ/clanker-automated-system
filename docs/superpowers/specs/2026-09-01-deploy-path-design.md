# The deploy path: from merged repo to live service

**Date:** 2026-09-01
**Status:** approved in brainstorming, pending implementation plan
**Implements:** Task D1a of [`2026-09-01-autonomous-operation.md`](../plans/2026-09-01-autonomous-operation.md)
**Supersedes nothing.** Extends the auto-deploy decision in [`docs/decisions.md`](../../decisions.md) ("Auto-deploy runs host-side, not agent-side").

## 1. The gap

The system can create a repo in AAS-Labs, push a branch, open a PR, review it and merge it — and then it stops. Nothing runs the result, nothing gives it a URL, and nothing notices whether a thing believed to be live is actually serving traffic. `goals.yaml`'s primary goal ("generate real, recurring income") is therefore unreachable by construction rather than merely difficult.

This design closes the mechanical half of that gap: **a merged repo becomes a running, publicly reachable service, and the system learns whether it stays up.** It deliberately does not cover acquiring the accounts, domains, or API keys a product may need — that is D1b, and §10 draws the line.

## 2. What already exists

`scripts/auto-deploy.sh` already closes "PR merged" → "live" for the supervisor itself: fetch, compare `HEAD` to the remote default branch, record a rollback target, fast-forward, `docker compose up --build -d`, poll Docker's `HEALTHCHECK` until healthy or unhealthy, `git reset --hard` back to the previous commit if it does not go healthy inside 90 seconds, and post one line to Discord either way. It runs from cron on the VPS host, every five minutes.

`docs/decisions.md:88-118` records why it is a host script and not an agent tool: triggering a redeploy from inside a container means mounting the Docker socket (close to host-root, the largest blast radius anything in this system would have) or giving an agent host SSH, to gain nothing, because "did the default branch move" is a fact rather than a judgment.

**This design generalises that script rather than replacing it.** Every property above is worth keeping: host-side, no agent-reachable Docker, automatic rollback on a failed health gate, quiet on the common case, one Discord line when it acts.

## 3. Desired state is a committed file

A new root file, `deploys.yaml`, lists what should be running:

```yaml
deployments:
  - slug: status-page
    repo: Clanker-HQ/clanker-automated-system-status
    hostname: status.203-0-113-5.sslip.io
    port: 8080
    env: []
```

An agent puts something live by opening a PR that adds an entry. Nothing else.

This is the central structural choice, and the reason for it is that **it inherits the entire existing safety pipeline for free**:

- CI already gates every PR on typecheck and tests, so a malformed entry cannot merge (§3.1).
- `pr-reviewer` already reviews every PR.
- `mergePR` already enforces its head-SHA match and its excluded-path lock.
- `auto-deploy.sh` already fetches this repo every five minutes, so the host already receives the desired state through a channel that exists. No Docker socket, no volume spelunking, no new network path, no new credential.

The alternative — an agent tool that deploys — would require putting Docker access inside the agent trust boundary, which §2 already rejected for the supervisor's own deploys and which is no more attractive for products.

### 3.1 Schema, and the self-build gate

`deploys.yaml` gets a Zod schema (`src/deploy/deploys-schema.ts`) loaded and validated at boot, exactly as `grants.yaml` is. A malformed entry is a boot error and a CI failure, not a runtime surprise on the host.

`evaluateSelfBuildChange` currently admits exactly two shapes: a PR touching only `grants.yaml`, or only `agents/<name>/{agent.yaml,prompt.md}` for one agent. Everything else is refused. So without a change here **an agent could never add a deployment at all.** `deploys.yaml` becomes a third admitted shape, under mechanical rules in the same spirit as the existing four:

- the resulting file must validate against the schema;
- an existing entry may not be edited in place, only added or removed (mirroring rule 2 for grants) — an in-place edit could repoint a live hostname at a different repo;
- `hostname` must not collide with an existing entry's, and must not be a hostname the supervisor itself serves;
- every name in `env` must already exist in the host's product environment. A deployment may not introduce a credential; that is D1b's job.

`deploys.yaml` is **not** added to `EXCLUDED_PATHS` — the whole point is that agents write it. Its safety comes from the schema plus these rules, per the standing preference that safety lives in scoping and algorithmic checks rather than a human approval click.

## 4. Hostnames and TLS

**Each entry declares its own hostname.** There is no single global base domain.

Caddy sits in front of everything, with one site block per entry reverse-proxying that hostname to that container's port, and obtains and renews a real Let's Encrypt certificate per hostname automatically. Rendering an explicit config from the desired state is deliberate: on-demand TLS would need an "ask" endpoint to avoid issuing certificates for arbitrary hostnames, which means Caddy calling back into the supervisor. Generating the config keeps it deterministic and dependency-free.

**Who writes that config, and when.** The renderer is ordinary TypeScript in the supervisor (`src/deploy/caddyfile.ts`), so it is unit-testable like everything else, and `docker-compose.yml` bind-mounts `./caddy` read-write into the container. The supervisor renders `caddy/Caddyfile` at boot, from the same validated `deploys.yaml` it already loads. The host script then reloads Caddy after it has finished bringing containers up. The ordering falls out of the existing sequence for free:

1. `deploys.yaml` changes on the default branch.
2. `auto-deploy.sh` fast-forwards and runs `docker compose up --build -d`, which recreates the supervisor.
3. The supervisor boots, validates `deploys.yaml`, and writes `caddy/Caddyfile`.
4. `deploy-products.sh` brings product containers up, reloads Caddy, and probes.

A bind mount rather than the named `agent-data` volume specifically because the host needs to read this file directly, and reaching into a named volume from the host is exactly the kind of path this design is trying to avoid. Rendering in the container rather than in bash keeps the logic in the language the tests are written in.

Two kinds of hostname follow from this, and the difference is a decision the operator made explicitly during brainstorming:

- **This system's own services** — the status page, and the eventual dashboard — use a free wildcard-DNS hostname of the form `<name>.<vps-ip-with-dashes>.sslip.io`, which resolves to the IP encoded in it with no registrar, no account and no DNS configuration. Zero setup, and adequate for something only the operator looks at.
- **Products** get a real domain. A free hostname of that shape is not acceptable on something the system is asking strangers to pay for, and the credibility cost is real. Until D1b can register a domain and point its DNS automatically, this is one manual operator step per product: buy the domain, point an A record at the VPS, add the entry.

That manual step is a feature, not a gap to apologise for. A domain costs about €10, so requiring one is a cheap, honest gate that a product only clears when it is genuinely worth shipping — which is the same kill-or-justify judgment Task C5 already forces at every portfolio review. When D1b automates registration, the gate becomes the `provision` grant's scope and its bank-enforced ceiling instead, and nothing in this design changes.

**One caveat to record:** Let's Encrypt's rate limits apply per registered domain, and every user of `sslip.io` shares one. Issuance for a `sslip.io` hostname can therefore occasionally be refused through no fault of this system. Because the hostname is per-entry, the fix is to change that entry — a free DuckDNS name, or a real domain — and not to redesign anything. Products are unaffected, since they use real domains.

## 5. The health gate

**The deploy gate is an external HTTP probe the host owns. A product's own `HEALTHCHECK` never gates its own rollback.**

This is the sharpest problem in the design. The supervisor's healthcheck is trustworthy because `Dockerfile` changes reach production only through a pipeline that cannot touch `EXCLUDED_PATHS`. A product's Dockerfile is written by an agent, and `HEALTHCHECK CMD exit 0` passes forever. A rollback triggered by a signal the deployed code controls is not a rollback.

So after bringing a container up, the host requests the entry's own public URL from outside — through Caddy, over the internet, exactly as a customer would — and requires a genuine 2xx or 3xx within a timeout. Anything else (a connection refused, a 5xx, a timeout, a TLS failure) fails the gate and rolls that entry back to its last SHA that passed. The probe lives in this repo, in `scripts/`, which §9 puts beyond the pipeline's reach.

An agent can still write an app that returns 200 while being useless. Nothing here claims otherwise; that is what the portfolio's `bar` and the graded expectations are for. What this gate does claim is narrow and worth having: *the thing is reachable at its public URL and serving.* That is the failure the rollback exists to catch, and it is not forgeable by the code being deployed.

Rollback state is per entry: the host keeps the last SHA that passed the probe for each slug, so one product failing to deploy neither rolls back another nor blocks the supervisor's own updates.

## 6. Liveness, and who consumes it

`PortfolioEntry` has no liveness field, and `src/state/liveness.ts` is about stale *metrics passes*, not deployed services. So a product that has been returning 502 for a week still reads as `status: "live"` to the overseer. That is the "computed by something, consumed by nothing" failure this plan has closed five times, inverted: an observable fact with nothing observing it.

A periodic prober (`src/triggers/probe.ts`, a cron trigger in the app — probing is an outbound HTTP GET and needs no host privileges, unlike deploying) requests every entry's hostname and writes `data/state/probes.json`: one record per slug with `url`, `lastProbeAt`, `ok`, and `consecutiveFailures`. Single writer, overwritten each pass, bounded by the number of entries.

It has **two consumers, both wired in the same task that creates it**, because a store with no reader is the exact defect this project keeps finding:

1. **The overseer's prompt.** `buildPromptContext` in `src/triggers/overseer.ts` gains a `## Product liveness` section beside the existing `## Due reviews`, rendering each entry's URL and current state, and saying so explicitly when a record is missing rather than rendering an empty section.
2. **The daily digest.** A pure `probeWarnings({ probes, now, maxAge })` in `src/deploy/probe-warnings.ts`, mirroring `stalePasses` exactly in shape and tone, returning a `⚠️` line per product that is down or whose probe has gone stale. `digest.ts` already pushes `stalePasses` output into its warning lines; this joins it.

The overseer therefore cannot review a portfolio without seeing that something it believes is live is not, and the operator sees it the next morning without asking.

## 7. Products and LLM providers

**No product ever uses the operator's Claude subscription.** `docs/decisions.md:31-40` grounds this system's subscription-billing choice on "no user-facing product is planned", because Anthropic does not permit offering claude.ai login or rate limits to a third-party product's end users without prior approval. `goals.yaml`'s `means` forbid violating any service's terms. So the obvious implementation — a product calling Claude with `CLAUDE_CODE_OAUTH_TOKEN` — is excluded by the goals themselves, and the design must say so where a builder agent will read it.

A product that needs a model gets **its own paid API key, from whichever provider is right for that product.** Nothing in the product path hardcodes Anthropic. Which provider — Anthropic, OpenAI, Google, an open-weight host — is a per-product question about cost, capability, and whether that provider's terms permit the use, and it belongs to the `research` agent, recorded as a `Finding` in the world model like any other researched conclusion.

Concretely, this design contributes only the seam: an entry's `env` names the variables its container needs, and the host passes them through from a product environment file the operator owns. D1a supports names that already exist there. D1b is what makes obtaining a new one automatic, and §3.1's fourth rule is what stops a deployment from claiming a credential that does not exist yet.

## 8. Resource limits

Products share the VPS with the supervisor. `config.yaml` gains `deploy.maxLiveDeployments` (default 5, sized for the planned 8 GB host), enforced by the same loader that validates the schema (§3.1) so a sixth entry fails at boot and in CI rather than exhausting memory at 3am. Each product container gets a memory cap in the rendered compose configuration, so one leaking product cannot take the supervisor down with it.

No second host until something actually outgrows this one. Splitting hosts before there is a product worth splitting for would be building for a problem the system has not got.

## 9. Two files that should already have been protected

`src/control/excluded-paths.ts` states its own principle plainly: *"A pipeline able to merge changes to its own gates is a pipeline with no gates: one PR weakens the check, the next does anything."* Two files that are gates by that definition are absent from the list, and nothing in the repo's docs suggests either omission was deliberate:

- **`scripts/auto-deploy.sh`** — owns the health gate and the rollback. An agent PR could weaken the very check that catches its own bad deploy. This design makes it considerably more load-bearing, since it will deploy products too.
- **`src/control/self-build-gate.ts`** — is the four mechanical rules themselves. A PR touching only this file touches no excluded path today, so it merges through the ordinary reviewer path. §3.1 gives it a third admitted shape to police, which makes the omission worse.

Both are fixed here by adding `scripts/` to `EXCLUDED_PREFIXES` and `src/control/self-build-gate.ts` to `EXCLUDED_PATHS`. This only ever **narrows** what the automated pipeline may touch, so it does not conflict with the standing rule against widening a grant or a limit while wiring.

## 10. What this design does not do

Explicitly out of scope, to keep the boundary with D1b legible:

- **Acquiring anything.** No account signup, no domain registration, no API key, no payment. An entry may only name credentials that already exist.
- **A runtime secret store.** Product environment variables are read by the host at deploy time. Making a key obtained at runtime usable without a redeploy is D1b's problem, and the `env` field is the seam it plugs into.
- **Deprovisioning.** Killing a portfolio entry removes its deployment, which stops its container and its hostname. It does **not** cancel any third-party service the product was paying for, because nothing yet signs up for one. This is D1b's most important requirement and is called out in the plan as the failure mode most likely to survive every other guard.
- **Browser-driven checkouts.** D1c, possibly never.
- **The dashboard's content.** §12 deploys a deliberately minimal status page as end-to-end proof. What it eventually shows is a separate design.

## 11. Prerequisite: the system must be on a public host

The system currently runs locally, on the operator's own machine. **Nothing in this design works end-to-end until it runs on a VPS**, because a laptop that sleeps cannot host a service and has no stable public address. Moving is a one-time manual operator step already documented at `README.md:55-72`: rent the box, clone the repo, write `.env`, add the crontab line.

This is a sequencing note, not a blocker on the work. Everything except the host script is ordinary in-process code — the schema, the self-build rule, the prober, the probe store, the warnings function, the overseer prompt section, the digest line — and is unit-testable on the current machine. The plan is therefore built, tested and merged the same way Tasks A1 through C6 were, and the host-side half activates on the day the VPS exists.

## 12. Testing strategy

Vitest, TDD, as everywhere else in this project. Unit-testable without a VPS, and therefore covered:

- `deploys-schema.ts` — valid file, unknown field, duplicate slug, duplicate hostname, entry count over `maxLiveDeployments`, `env` naming an absent variable.
- The self-build rule — a PR adding an entry is admitted; editing an entry in place is refused; a colliding hostname is refused; a PR mixing `deploys.yaml` with an unrelated file is refused as before.
- Caddyfile rendering — one entry, several entries, zero entries; output is stable given the same input.
- `probe-warnings.ts` — pure, like `stalePasses`: all healthy yields no lines; a down product yields one; a stale probe yields one; an empty store yields the "never probed" line.
- The probe store — missing file reads as empty and never throws, matching `readPortfolio` and `MetricsStore.listAll`.
- The overseer prompt section — renders each entry; says so explicitly when a record is missing rather than rendering an empty section (the same defect Task C5's `renderDueReviews` guards against).
- The prober trigger — driven deterministically via `job.trigger()`, as `tests/cron-trigger.test.ts` and `tests/metrics-trigger.test.ts` already do.

The host script is bash and is verified by its first real run, announced in Discord either way. The end-to-end proof is one deliberately minimal service — a static status page in its own repo — deployed through the full path onto a `sslip.io` hostname: PR, CI, review, merge, pull, build, route, probe, and a Discord line. If that page is reachable over HTTPS and its liveness appears in the next digest, the path works.

## 13. File structure

```
Create:
  deploys.yaml                          desired state, agent-writable
  src/deploy/deploys-schema.ts          Zod schema + loader
  src/deploy/caddyfile.ts               render Caddy config from entries
  src/deploy/probe-store.ts             read/write data/state/probes.json
  src/deploy/probe-warnings.ts          pure, mirrors state/liveness.ts
  src/triggers/probe.ts                 periodic prober cron trigger
  scripts/deploy-products.sh            host-side: clone, build, route, probe, roll back

Modify:
  docker-compose.yml                    bind-mount ./caddy read-write; add the caddy service
  scripts/auto-deploy.sh                call deploy-products.sh after its own deploy
  src/control/self-build-gate.ts        third admitted shape + its rules
  src/control/excluded-paths.ts         protect scripts/ and self-build-gate.ts
  src/triggers/overseer.ts              ## Product liveness in buildPromptContext
  src/digest.ts                         probeWarnings into the warning lines
  src/config.ts, config.yaml            deploy.maxLiveDeployments
  src/index.ts                          boot wiring for the prober
  agents/builder/prompt.md              how to put something live; no subscription token in a product
  docs/decisions.md                     record §7's resolution of the billing contradiction
  README.md                             the deploy path, and the per-product domain step
```

`src/deploy/` is a new directory, kept separate from `src/state/` because these files are about services this system deploys rather than about its own internal state, and separate from `src/world/` because they are machine-written rather than agent-written.
