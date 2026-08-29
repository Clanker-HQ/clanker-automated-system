# Claude Agent Infrastructure

Runs Claude agents unattended on a schedule, authenticated by a **Claude
subscription** rather than the API. Results are reported to Discord.

Past architectural decisions and accepted risks: [`docs/decisions.md`](docs/decisions.md).

## Setup

1. `cp .env.example .env`
2. Run `claude setup-token` and paste the token into `CLAUDE_CODE_OAUTH_TOKEN`.
   It is long-lived access to your whole Claude account — it never leaves `.env`,
   which is gitignored.
3. Create a Discord incoming webhook (Server Settings → Integrations → Webhooks →
   New Webhook → Copy Webhook URL) and paste it into `DISCORD_WEBHOOK_SMOKE`.
4. Create a Discord Application + Bot at https://discord.com/developers/applications,
   enable the **Message Content** privileged intent under Bot settings (the bot
   can't read approve/deny/answer replies without it), and invite it to your
   server with the `bot` scope. Paste the bot token into `DISCORD_BOT_TOKEN`
   (never the webhook URL from step 3 — the bot needs a real bot token, not a
   webhook). Then, for each channel key already under `discord.channels` in
   `config.yaml`, add the same key under `discord.botChannels` pointing at an
   env var holding that channel's numeric Discord channel ID (right-click the
   channel with Developer Mode on → Copy Channel ID) — e.g.
   `botChannels: { smoke: DISCORD_CHANNEL_ID_SMOKE }`, with
   `DISCORD_CHANNEL_ID_SMOKE=<numeric id>` in `.env`. The webhook stays for
   routine one-way reports; the bot uses the channel ID to post approvals,
   questions, and admin command replies into the same channel.
   Finally, set `DISCORD_OWNER_ID` to **your own** numeric Discord user ID
   (Developer Mode on → right-click your name → Copy User ID). That single
   account is the only one the bot obeys: approve/deny/answer and every `!`
   command from any other author is ignored without a reply. Boot fails if it
   is unset, the same way a missing bot token does — an approval anyone in the
   channel could give is not an approval.
5. Set `GITHUB_PR_TOKEN` (a fine-grained PAT on a dedicated, single-purpose
   bot account, scoped to **all repositories** on that account with only
   Contents:Read + Pull requests:Read&write — no Administration, no billing,
   no other-account access) and `GITHUB_WEBHOOK_SECRET` (the shared secret
   you'll configure when adding a repo's webhook under Settings → Webhooks —
   this still has to be done per repo; there's no account-wide webhook).
   Both are `mustEnv`, the same as `DISCORD_OWNER_ID` above — boot fails
   without them, even before any agent is actually webhook-triggered.
6. `docker compose up --build`

To exercise the whole pipeline **without consuming any subscription quota**, set
`RUNNER=fake` in `.env` first. The boot log states which mode is live:

```
[boot] RUNNER=fake — no subscription quota will be consumed
[boot] credentials: subscription
```

Check that line before the first real run.

## Adding an agent

Create `agents/<name>/agent.yaml` and `agents/<name>/prompt.md`, then restart the
supervisor. Legal values for every field are in `schema/capabilities.json`; the
JSON Schema is `schema/agent.schema.json`. Regenerate both with `npm run schema`.

Every field the current code cannot enforce is **rejected at boot** with a message
naming the plan that will deliver it, so a setting never silently does nothing.

## Operating

| | |
|---|---|
| Stop everything | `docker compose exec supervisor touch /app/data/STOP` |
| Resume | `docker compose exec supervisor rm /app/data/STOP` |
| Run history | `docker compose exec supervisor sh -c 'ls /app/data/runs'` |
| A run's transcript | `.../runs/<runId>/transcript.jsonl` — written as events arrive, so it survives a crash |
| Undelivered reports | `data/undelivered/` — only exists if Discord rejected a message three times |

### From Discord

Everything below works only for the account in `DISCORD_OWNER_ID`. Messages
from anyone else are ignored silently — no reply, no effect — so don't debug a
"broken" bot before checking which account you typed from.

**Answering a parked run.** When a run stops to ask for something, the bot
posts the request and an id. Reply in that channel:

| | |
|---|---|
| `approve <id>` | Allow the matched grant for the rest of this run (not just this one call) and let the run continue from where it stopped |
| `deny <id>` | Refuse it; the agent is told to continue with anything else, or stop |
| `answer <id> <text>` | Free-text reply to a question (`answer 3f2a-… use the main branch`) |

An approval that can't be resumed right now (STOP file, quiet hours, budget
spent, a rate-limit rejection) replies to say so and **leaves the entry open** —
try again later, the id stays valid. Entries older than
`governor.pendingTimeoutHours` are auto-denied at the next restart.

**Admin commands.**

| | |
|---|---|
| `!stop` | Write the STOP file — no new runs, and no resumes, until `!resume` |
| `!resume` | Remove the STOP file |
| `!disable <agent>` | Stop triggering that one agent (a human resume still works). Refused, naming the agents that do exist, if `<agent>` matches none of them — a typo has no legitimate effect to have |
| `!enable <agent>` | Re-enable it, and reset its circuit breaker. Still applied for a name matching no currently-loaded agent (the only way to clear a stale override left by an agent since removed from config), but the reply says so rather than implying a real agent was re-enabled |
| `!budget <n>` | Set the daily spend ceiling in USD, e.g. `!budget 25` |
| `!concurrency <n>` | Set how many runs may be in flight at once |
| `!quiet HH:MM-HH:MM Area/City` | Set quiet hours, e.g. `!quiet 02:00-03:00 Europe/Berlin`. Same-day windows only — `from` must be earlier than `to`, so an overnight window like `22:00-07:00` (or `from` equal to `to`) is refused outright rather than written and then silently never suppressing anything; the timezone must also be a canonical IANA name, and a bad one is likewise rejected with the reason rather than written |
| `!quiet off` | Disable quiet hours |
| `!breaker off` | Disable the circuit breaker — a tripped agent no longer refuses a trigger |
| `!breaker on` | Re-enable it |
| `!runs` | The last 20 runs — id, status, cost |
| `!status` | One-shot live snapshot: STOP state, quiet hours, budget spent today, concurrency, breaker, disabled agents, task counts |
| `!task [-d] [-p <n>] <text>` | Queue a free-form request; replies with its task id. `-d` asks for a longer final summary, `-p <n>` sets its priority (default 50) |
| `!tasks` | Tasks not yet finished — id, status, truncated text |
| `!result <id-or-prefix>` | Look up any task, finished or not, by full id or the short id `!tasks` shows |
| `!retry <id-or-prefix>` | Requeue a failed task, keeping its earlier routing decision |
| `!cancel <id-or-prefix>` | Remove a still-pending task before it runs |

These write to `data/config-overrides.json` and take effect on the next
admission check; they override `config.yaml` until changed back. `!concurrency`
is the one exception worth calling out: raising it takes effect immediately,
admitting any runs already queued behind the old, lower limit right away
rather than making them wait for enough of the currently-running ones to
finish first.

**The task queue.** `!task <text>` durably queues a free-form request under
`data/tasks/<id>.json` — it survives a restart. Capped at 4000 characters,
so an accidental giant paste is rejected up front rather than queued. A
dispatcher claims pending tasks highest-priority first, asks a cheap routing
call which specialist should handle each one, and runs it through the same
Governor as every other agent. Claimed tasks run concurrently, not one at a
time — actual concurrency is bounded by `governor.maxConcurrent`, the same
limit a cron agent's trigger is already subject to, not by how many tasks
happen to be queued. Today there is exactly one specialist, `research`: it
searches and reads the open web and writes up what it finds, with no code
changes, no publishing, and no spending. When the run finishes, the channel
gets a
task-id-correlated line (`✅ Task <id> done: …` or `❌ Task <id> failed: …`)
alongside the agent's own run report, and the full artifact is on disk under
`data/runs/<runId>/`. That completion line is a short summary by default;
`!task -d <text>` asks the specialist for a longer, more substantive one in
that same message instead — still whatever shape fits (a list, a short
comparison), not forced into paragraphs, and still capped for readability.
A task whose run parks for an approve/deny/answer shows as `waiting` in
`!tasks` — the run is alive, not failed. Once you `approve`/`deny`/`answer`
it to real completion, the task record catches up too — done with its result,
or failed with the reason — the same way a task that never parked would. An
entry that instead ages past `governor.pendingTimeoutHours` and is
auto-denied on restart is handled too: the task behind it is marked `failed`
(reason: the request timed out unanswered) at the same startup reconciliation
pass that auto-denies the entry, so it never sits `waiting` forever with
nothing actually coming.

`!tasks` only lists what's still active, so once a task finishes its
completion message in the channel is the only other record of it —
`!result <id-or-prefix>` looks any task back up regardless of status (queued,
running, waiting, done, or failed) and shows the full, untruncated detail.

A task whose run doesn't succeed is silently retried once — a lot of failures
are transient (a flaky fetch, a momentary rate limit) — before it's actually
marked `failed` and posted to the channel. The retry waits for the next
dispatcher tick rather than firing immediately, so a genuinely broken task
doesn't burn two attempts back-to-back. `!retry` on an already-failed task
resets this, so a manual retry always gets its own fresh silent attempt too.

**Daily digest and data retention.** Two scheduled jobs, both configured under
`digest:`/`retention:` in `config.yaml`, neither needing a command:
- `digest` posts once a day (08:00 by default): runs and spend in the last
  24h, tasks done/failed, and anything still `waiting` on you regardless of
  how old — so a day away doesn't mean piecing state back together from
  `!status`/`!tasks`/memory of what you last checked.
- `retention` runs weekly and deletes run transcripts/results and specialist
  workspace files (e.g. research findings) older than `retention.days`
  (30 by default). A run still in progress (no `result.json` yet) is never
  touched. Posts to the channel only when it actually removed something, and
  separately reports (never deletes) any run whose transcript went stale
  with no result ever recorded — that's not a run still in progress (every
  agent's timeout caps at 3 hours), it's one the process crashed mid-way
  through.

**The system can queue its own tasks, not just yours.** Three cron-triggered
agents each propose up to 3 tasks via a `queueTask` tool — no human approval
needed to queue, matching every other read-only or proposal-only action in
this system. A self-queued task is indistinguishable from a `!task` one once
it exists — same routing, same Governor admission, same
`!tasks`/`!result`/digest visibility — except its `createdBy` reads
`agent:<name>` instead of `discord:<id>`, and it starts at a lower default
priority (30 vs. 50) so it never queues ahead of something a human actually
asked for. `opportunity-scout` looks for plausible ways to earn money and
queues research questions for `research` to investigate; `improvement-scout`
reads this project's own source and docs and queues concrete gaps or
capability ideas — both run daily. `cleanup-scout` runs weekly and hands
stale-doc/dead-reference fixes to `builder` instead of `research`, since
fixing them means actually editing files, not investigating further. None of
the three can write, push, fetch, or spend beyond proposing — all three run
at `tier: readonly`.

**A process crash is no longer invisible.** An uncaught exception or
unhandled rejection anywhere is caught, written to `data/state/crash.log`,
and posted to Discord as a best-effort alert before the process exits.
Docker's `restart: unless-stopped` was already bringing it back either way —
this just means a 3am crash leaves a trace instead of an unexplained restart.

**Agent config that can never do what it says fails to load.** `tier:
"granted"` (or anything but `"autonomous"`) combined with `approval: "auto"`
looks like it should skip human approval, but `decide()` only ever
auto-allows for `tier: "autonomous"` — every other tier parks regardless,
making `approval: "auto"` silently inert. This is exactly the bug `research`
briefly shipped with; it's now a boot-time validation error instead of
something only a reviewer might catch.

**Task and override writes are serialized per key.** `TaskStore.update()` and
`ConfigOverridesStore.set()` both read-whole-file, mutate, write-whole-file —
with nothing else guarding them, the dispatcher's tick and a Discord command
landing on the same task/override at the same instant could otherwise read
the same "before" state and have one write silently clobber the other's. A
small in-process `KeyedMutex` (`src/keyed-mutex.ts`) queues same-key callers
instead. In-process only — this runs as one supervisor process per data
directory, so there's no cross-process case to guard against.

**The daily-budget check no longer rescans all of retained run history on
every admission.** `Governor.admit()` runs on every cron trigger and every
dispatched task, and used to sum today's spend by reading and JSON-parsing
every `result.json` under `data/runs/` — cost scaling with total retained
history (`retention.days`, 30 by default, or unbounded if raised/disabled),
not with today's run count. `RunStore.listSince()` pre-filters candidates
using the timestamp `newRunId` already embeds in the run's directory name,
so a run outside the window (with a full day of slack on each side) is
skipped without ever being read — the exact per-run check still happens
against its real recorded `startedAt`, so this changes how much gets read,
never which runs count. The daily digest's "last 24h" query uses the same
method for the same reason.

**A stalled task-routing call can no longer freeze the whole task queue.**
`Dispatcher.wake()` claims and routes pending tasks one at a time — only
actually *running* a routed task happens concurrently — so a routing call
that hangs (not errors, hangs: a stalled connection, a dropped response)
used to block every other queued task behind it indefinitely, with no
recovery short of a process restart. `LlmRouter` now aborts a routing call
after 60 seconds and treats it as "no specialist matched," the same outcome
as the model genuinely replying "none."

## Development

- `npm test` — full suite, consumes no quota
- `npm run typecheck`
- `npm run probe` — **one real Haiku call**; prints raw SDK messages and proves authentication works

## Things worth knowing before you trust it

**`status: "success"` means the SDK finished without erroring — not that the agent
achieved its objective.** A run can return a well-formed answer and still have
failed to do the thing. Nothing here verifies outcomes yet. Read the transcripts
early on.

**Agents share one rate limit with your own interactive Claude use.** The
governor is live: it enforces `maxConcurrent`, `dailyBudgetUsd`, `quietHours`,
a manual `!disable`, the STOP file, and a circuit breaker that trips after
three consecutive failed or timed-out runs of the same agent (`!enable <agent>`
resets it; `!breaker off` disables the check entirely). It admits runs with an
eye on the SDK's own `rate_limit_event` utilisation reporting.

If Claude usage runs through a dedicated subscription/account that this
project doesn't need to budget against, `!quiet off`, a high `!budget`, and
`!breaker off` together turn the governor's admission checks into a no-op
(short of the STOP file, which stays a manual, deliberate switch — folding it
in would mean `!stop` no longer stops anything).

**A refused run is skipped, not queued.** Only `maxConcurrent` makes a run
*wait* — it holds until a slot frees. Every other refusal (quiet hours, budget
spent, breaker tripped, rate-limit rejection, STOP file, a disabled agent)
simply drops that cron fire: it is logged, alert-worthy ones post a Discord
alert, and nothing is retried or queued. The agent's next run is its next
scheduled fire. **One exception: a dispatched task.** A `!task` refused
admission goes back to `pending` with its routing decision kept, and is
retried on the dispatcher's next periodic tick (or the next `!task` / finished
run) — a queued task has nowhere else to go, unlike a cron agent that gets
another fire regardless. It is not dropped, and it is not notified per retry
either; `!tasks` still showing it is how you know it's waiting on the governor.
Don't read "parked" into this — in this system **parked** means
something narrower and quite different: an *in-flight* run that stopped
mid-execution to await a human approve/deny/answer, and which resumes its
original session when you give it.

**`Bash`'s outward-effect detection is a pattern list, not a hard boundary.**
Every tier below `autonomous`-with-auto-approval is only as safe as the code's
ability to recognize "this call reaches outside the workspace" — `git push`
vs. `git commit`, `curl`ing a real host vs. localhost, `npm publish`, and
similarly for `WebFetch`'s URL — and `Bash` is free-form text, so there's no
clean lookup the way there is for "is this tool name allowed." `detectOutwardEffect`
in `src/grants.ts` recognizes a fixed, explicit list of outward-reaching
shapes; a recognized one is then checked against tier and grants (denied
outright for `readonly`/`sandboxed`, matched against `grants.yaml` for
`granted`/`autonomous`). Anything it **doesn't** recognize inside a `Bash`
call is allowed to proceed regardless of tier — that's a real, named gap, not
a hidden one: an unusual command could slip an outward effect past this check
even for a `sandboxed` agent. The backstop is the tier's own reach — a
`sandboxed` agent has no grant and no credential to act on even if a pattern
slips through, so the worst case is "it tried and had nothing to push to" —
but don't treat `sandboxed` as airtight against a determined or confused
agent, and don't grant `granted`/`autonomous` to an agent whose `Bash` usage
you haven't read.

**A grant matches on kind and target only — its narrowing fields are validated
but not enforced.** When an effect is checked against `grants.yaml`, the match
compares the grant's family (`http` / `git-push` / `provision`) and its target
pattern (`urlPattern` / `remote` / `scope`, with `*` wildcards). Three fields
are checked for well-formedness at boot and then never consulted again at match
time:

- `method` on an `http` grant. A grant scoped to `method: POST` currently also
  authorizes a `DELETE` to the same URL.
- `branches` on a `git-push` grant, for a raw Bash `git push` (no explicit
  branch argument detected). A grant scoped to `branches: [main]` still
  authorizes a Bash `git push` to any branch on that remote — this field
  is only enforced for the `pushBranch` MCP tool's own effect, which
  carries an explicit branch and checks it against this list (see
  `src/grants.ts`'s `matchGrant`).
- `limit.perDay` on a `provision` grant. Nothing counts uses, so the cap is not
  applied.

Reading a method or a branch name back out of a free-form `Bash` string is the
same unsolved problem as `detectOutwardEffect` above, which is why it isn't
faked. The practical consequence: read a real grant as "this agent may reach
this target, by this family of effect" and nothing narrower. `grants.yaml` now
backs two live credentials (`infra-repo`'s `GITHUB_PR_TOKEN` and
`builder-push`'s `BUILDER_PUSH_TOKEN`) alongside the synthetic `test-echo` and
broad `web-read` grants — a grant you add for a real credential should be
scoped by its `urlPattern`/`remote`, and by what the credential behind it is
allowed to do, rather than by `method`, which is unenforced everywhere, or
`branches`, which is enforced only for `pushBranch` and still unenforced for a
raw Bash `git push`.

**Tool calls need absolute paths.** An agent prompt that says "read `notes.md` in
your working directory" will fail its first tool call. Say so explicitly in the
prompt, and give the agent `Glob` so it can locate itself.

## Not built yet

The governor, capability tiers and grants, park/resume, and the Discord control
bot (approvals, questions, admin commands) are all built and live.
Still genuinely deferred:

- **Git-based deploy and the "proposal approval" Discord flow** — an agent
  writing a new `agent.yaml`, the supervisor pulling and validating it, and
  asking to merge it. The `builder` agent (`agents/builder/`) can now write
  and open a PR for an ordinary code change, but nothing yet produces a
  proposal branch that changes this system's own agent configuration, so
  there's still nothing for the deploy/approval machinery to act on.
- **Outcome verification.** `status: "success"` still only means the SDK
  didn't error, not that the agent's objective was achieved (see above).
- **Browser capability** (`capabilities.browser`) — Plan C territory.
- **The repo is real; the webhook and the builder's own token still aren't.**
  This system now lives at `Clanker-HQ/clanker-automated-system` on GitHub,
  and `GITHUB_PR_TOKEN`/`GITHUB_WEBHOOK_SECRET` are set, so `infra-repo`
  authorises real PR review/merge calls once a repo's webhook is actually
  configured (Settings → Webhooks — still per-repo, no account-wide
  equivalent). `builder-push` already points at this same real repo, but
  `BUILDER_PUSH_TOKEN` itself is still unset, so `pushBranch` has nothing to
  authenticate with yet — generate that PAT on the bot account
  (Contents:Write + Pull requests:Write, this repo only) before relying on
  `builder`.
