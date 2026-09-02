# Web Dashboard — Design Spec

## Goal

A single-page web dashboard that surfaces everything currently only visible
through Discord `!status`/`!tasks`/`!runs`/etc., plus two sections that exist
in the data stores today but aren't exposed anywhere at all
(world model / findings, and metrics trends), with a curated set of the same
runtime controls the Discord bot already exposes. Must be usable from a phone
browser. Discord remains fully in place — this is an additional view, not a
replacement.

## Context and constraints

- The system currently runs as a single long-lived Node process, started
  locally (no VPS is rented yet — `README.md`'s "Not built yet" section and
  this session's own standing rule hold off on that spend until something has
  earned it).
- There is no database anywhere in this codebase. Every store
  (`TaskStore`, `RunStore`, `ConfigOverridesStore`, `BreakerStore`,
  `WorldModel`, `MetricsStore`, ...) is JSON files (or, for `WorldModel`,
  Markdown with embedded fenced JSON) under `data/`, written with
  `writeFileAtomic` (temp file + rename).
- There is exactly one other long-lived HTTP server in the codebase today:
  `WebhookReceiver` (`src/control/webhook-receiver.ts`), built on raw
  `node:http` — no Express/Fastify/etc. dependency exists anywhere in
  `package.json`. This design adds a second server of the same kind, not a
  new framework.
- There is no existing inbound web-facing auth mechanism. The two auth
  mechanisms that exist are Discord's single-owner check
  (`msg.authorId !== this.ownerId`, `src/control/bot.ts:167`) and the
  webhook's HMAC-SHA256 signature check
  (`src/control/webhook-signature.ts`), which uses `timingSafeEqual` to avoid
  a byte-by-byte timing oracle. This design introduces the first web-facing
  auth for a human, following the same constant-time-comparison discipline.
- **Decided with the user:** this is designed to eventually run on a VPS
  behind Caddy (the reverse proxy already used for product deploys, see
  `src/deploy/caddyfile.ts`), which terminates TLS — but the VPS itself is
  **not** being provisioned as part of this work. Until then, the same
  server runs locally and is reached over the LAN (phone on the same Wi-Fi
  as the desktop, e.g. `http://<lan-ip>:8788`) or through a free tunnel
  (ngrok, the same tool already used for the GitHub webhook in dev) when
  away from home. No code branches on "local" vs. "VPS" — it is the same
  server either way; only what sits in front of it changes.

## Architecture

```
Phone or laptop browser
        │  HTTPS (ngrok / Caddy) or HTTP (LAN)
        ▼
DashboardServer (new, src/control/dashboard-server.ts)
  - raw node:http, own port (DASHBOARD_PORT)
  - HTTP Basic Auth gate in front of every route, including the static page
  - GET  routes → read from existing stores, return JSON
  - POST routes → validate, write through the SAME store methods
    bot.ts already calls, so a change from the dashboard is
    indistinguishable in the audit log except for setBy: "dashboard"
        │
        ▼
Existing stores (unchanged): TaskStore, RunStore, ConfigOverridesStore,
BreakerStore, WorldModel, MetricsStore, Governor, Dispatcher
```

`DashboardServer` is started in `src/index.ts::main()` next to
`webhookReceiver` — independent lifecycle, so if it fails to bind (e.g. port
in use) it logs and the rest of the process (Discord bot, dispatcher, cron
triggers, webhook receiver) is unaffected, mirroring exactly how a failed
`webhookReceiver.listen()` is already handled there (`src/index.ts:319-333`).

**Optional, like `RevenueTransport`, not required, like `GITHUB_PR_TOKEN`.**
The dashboard only starts when both `DASHBOARD_USER` and `DASHBOARD_PASSWORD`
are set. Neither is `mustEnv`'d — an environment that doesn't set them (every
existing deployment, until this is rolled out; any test environment) simply
doesn't run a dashboard, logged once at boot, the same posture already used
for `REVENUE_API_TOKEN`.

## Components

### 1. `DashboardServer` (`src/control/dashboard-server.ts`, new)

Same split `WebhookReceiver` uses, for the same reason: a pure, fully-testable
`handleRequest` with zero real sockets, and a thin `listen()` adapter.

```ts
export interface DashboardDeps {
  tasks: TaskStore;
  runs: RunStore;
  overrides: ConfigOverridesStore;
  governor: Governor;
  breaker: BreakerStore;
  world: WorldModel;
  metrics: MetricsStore;
  dispatcher: Dispatcher;
  agents: AgentDef[];
  dataDir: string;
}

export class DashboardServer {
  constructor(opts: { user: string; password: string; deps: DashboardDeps });

  /** Pure request handling — no real HTTP involved, exactly like WebhookReceiver.handleRequest. */
  async handleRequest(req: {
    method: string;
    path: string; // pathname only, no query string
    query: URLSearchParams;
    authHeader: string | undefined;
    body: string; // raw, unparsed
  }): Promise<{ status: number; headers?: Record<string, string>; body: string }>;

  async listen(port: number): Promise<void>;
  async close(): Promise<void>;
}
```

Every request (including the static page) is checked against
`DASHBOARD_USER`/`DASHBOARD_PASSWORD` before any routing happens. Missing or
wrong credentials get `401` plus `WWW-Authenticate: Basic realm="dashboard"`
(triggers the browser's native credential prompt — no custom login page or
client-side auth code needed). The comparison hashes both the expected and
provided `user:password` strings with SHA-256 first (fixed 32-byte output),
then compares with `timingSafeEqual` — this sidesteps the length-based
short-circuit `verifyGithubSignature` accepts for HMAC digests (already
fixed-length there), which raw credential strings of arbitrary, attacker-known
length would otherwise leak.

### 2. Extract `resolveTaskByPrefix` out of `DiscordBot` (small refactor)

`bot.ts` has a private `resolveTaskByPrefix(prefix)` (`src/control/bot.ts:308-316`)
that turns the short id `!tasks` shows (or a full id) into exactly one task,
returning a typed error for "no match" and "ambiguous — matches N tasks" —
used by `!result`/`!retry`/`!cancel`. The dashboard's `GET /api/tasks/:id`,
`POST /api/tasks/:id/retry`, and `POST /api/tasks/:id/cancel` need the exact
same resolution (a task id in a URL is realistically going to be the short
form too, copied from the tasks list). Rather than re-implement — and risk
drifting from — that matching logic a second time, extract it as a standalone
function in a new `src/control/resolve-task.ts` (`resolveTaskByPrefix(tasks: TaskStore, prefix: string)`),
imported by both `bot.ts` and `dashboard-server.ts`.

### 3. Two small additions to existing stores (both read-only, both additive)

- **`RunStore.readTranscriptTail(runId: string, lines: number): Promise<string[]>`**
  — same logic as the private `tail()` a `RunWriter` already exposes
  (`src/run-store.ts:115-118`), but callable for *any* run id after the fact,
  not just one currently open for writing. Needed for the run-detail view.
- **`WorldModel.listFindings(): Promise<Finding[]>`** — the full `Finding`
  objects `summaryForPrompt()` already assembles internally
  (`src/world/world-model.ts:204-234`) via its private `listFindingTopics()` +
  `readFinding()`, exposed as its own method instead of only the
  truncated-for-prompt digest string. Needed for the world-model browser.

Neither store's existing behavior changes; both additions are pure reads.

### 4. Static frontend (`public/dashboard/index.html`, new)

One file: inline `<style>` and `<script>`, no build step, no framework —
vanilla JS `fetch()` calls against the `/api/*` routes below, matching the
zero-frontend-dependency posture of the rest of this repo. Served by
`DashboardServer` for `GET /` (after the same auth check as everything else).

Layout: a tab bar (Status / Tasks / Runs / Config / World / Metrics) that
becomes a bottom nav bar under a small-width media query, CSS grid/flexbox
throughout, no fixed pixel widths — so it reads well on a phone without a
separate mobile build. The active tab polls its own endpoint every 10s;
switching tabs fetches immediately. `Authorization` is never handled in
JS — the browser attaches it automatically once Basic Auth has been entered
once, for every subsequent request to the same origin.

## API contract

All reads are `GET`, return `200` with a JSON body on success. All writes are
`POST`, accept a JSON body (when they take input), and return the same shape
`ConfigOverridesStore`/`TaskStore`/etc. already produce — no new response
schema invented where an existing type already fits.

| Method & path | Mirrors | Reads/writes |
|---|---|---|
| `GET /api/status` | `!status` | `governor.status()` + task counts by status |
| `GET /api/tasks` | `!tasks` | `tasks.list()`, filtered to pending/queued/running/waiting, sorted like the bot does |
| `GET /api/tasks/:id` | `!result` | `resolveTaskByPrefix()` (any status) — 404 on no match, 409 on an ambiguous prefix |
| `POST /api/tasks` `{ text, priority?, wantsDetail? }` | `!task` | Same `MAX_TASK_TEXT_LENGTH` cap; `createdBy: "dashboard"`; wakes the dispatcher |
| `POST /api/tasks/:id/retry` | `!retry` | `resolveTaskByPrefix()`, then same "must be failed" check; resets retry state |
| `POST /api/tasks/:id/cancel` | `!cancel` | `resolveTaskByPrefix()`, then same "must be pending" check |
| `GET /api/runs?limit=20` | `!runs` | `runs.listRecent(limit)` |
| `GET /api/runs/:id` | `!result` (for a run) | `runs.readResult(id)` + `runs.readTranscriptTail(id, 200)` (new method above) |
| `GET /api/config` | (new — not in Discord) | `{ overrides: ConfigOverrides, resolved: GovernorConfig }` — raw `overrides.read()` plus `resolveGovernorSettings()`, so the UI can show effective values even when unset |
| `POST /api/config/budget` `{ value }` | `!budget` | Same `Number.isFinite && > 0` validation |
| `POST /api/config/concurrency` `{ value }` | `!concurrency` | Same integer `> 0` validation; also calls `governor.adjustConcurrency(value)` |
| `POST /api/config/quiet-hours` `{ from, to, timezone }` or `{ off: true }` | `!quiet` | Same `QuietHoursSchema` validation |
| `POST /api/config/breaker` `{ enabled }` | `!breaker` | — |
| `POST /api/agents/:name/disable` | `!disable` | Same "must be a loaded agent name" check |
| `POST /api/agents/:name/enable` | `!enable` | Same stale-override tolerance + `breaker.reset()` |
| `POST /api/stop` | `!stop` | Writes the `STOP` sentinel file |
| `POST /api/resume` | `!resume` | Removes it |
| `GET /api/world` | (new) | `{ portfolio: world.readPortfolio(), shelf: world.readShelf(), findings: world.listFindings() }` (new method above) |
| `GET /api/metrics?days=30` | (new) | `metrics.listAll()`, filtered to the last N days |

Every write endpoint calls `overrides.set(key, value, "dashboard")` (or the
task/breaker equivalent) — the exact same code path `bot.ts` calls with
`"discord"` in that same argument position — so `data/state/audit.log` shows
one uniform trail regardless of which surface made the change, and no
validation rule is duplicated or drifts between the two entry points.

## Error handling

Matches `WebhookReceiver`'s existing conventions exactly:

- Malformed JSON body / failed validation → `400` with a short plain-text
  reason (reusing `formatZodError` where a Zod schema is already the source
  of truth, e.g. quiet-hours).
- Missing/wrong Basic Auth → `401`, generic body (no hint which of
  user/password was wrong — same anti-probing stance as the Discord bot's
  silent-ignore-on-mismatch).
- Unknown path/method, or a task id prefix matching nothing → `404`.
- A task id prefix matching more than one task → `409`, listing the short ids
  it matched (same message `resolveTaskByPrefix` already produces for `!result`/
  `!retry`/`!cancel`).
- Unexpected internal error → `500`, nothing leaked in the body, full detail
  `console.error`'d server-side.

## Testing

- `DashboardServer.handleRequest` unit-tested directly (no real sockets),
  following this repo's existing convention of exercising stores against a
  real temp directory rather than mocking them (matches how `TaskStore`,
  `ConfigOverridesStore`, etc. are already tested elsewhere) — auth
  acceptance/rejection, each read endpoint's shape, each write endpoint's
  validation and its effect on the underlying store, and that a rejected
  write leaves the store unchanged.
- `RunStore.readTranscriptTail` and `WorldModel.listFindings` get their own
  focused unit tests alongside each store's existing test file.
- The static page is verified manually in a browser (desktop width and a
  phone-width viewport), per this repo's standing instruction that frontend
  changes get browser-verified rather than claimed from type-checking alone
  — there is no frontend test tooling in this repo to extend for it.

## Env vars (added to `.env.example`)

```
# Web dashboard — optional. Both must be set for it to start; leaving either
# empty means no dashboard server runs (matches REVENUE_API_TOKEN's posture).
# Basic Auth, so keep this on HTTPS in any real deployment (ngrok now, Caddy
# once/if a VPS exists) — credentials go out with every request.
DASHBOARD_PORT=8788
DASHBOARD_USER=
DASHBOARD_PASSWORD=
```

## Out of scope / deferred

- Provisioning any VPS or domain, and wiring a Caddyfile entry for the
  dashboard — explicitly deferred per the earlier decision in this
  conversation; today's design just doesn't preclude it later.
- Websocket/SSE live push — polling is enough at this scale and this is far
  simpler to build and reason about.
- Any second dashboard account, role, or permission level — this remains a
  single-operator tool, same as Discord's single `DISCORD_OWNER_ID`.
- A build step / frontend framework — revisit only if the single-file page
  genuinely becomes unwieldy to maintain.
