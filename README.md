# Claude Agent Infrastructure

Runs Claude agents unattended on a schedule, authenticated by a **Claude
subscription** rather than the API. Results are reported to Discord.

- Design: [`docs/superpowers/specs/2026-08-26-claude-agent-infrastructure-design.md`](docs/superpowers/specs/2026-08-26-claude-agent-infrastructure-design.md)
- Plan A (this code): [`docs/superpowers/plans/2026-08-26-plan-a-the-loop.md`](docs/superpowers/plans/2026-08-26-plan-a-the-loop.md)

## Setup

1. `cp .env.example .env`
2. Run `claude setup-token` and paste the token into `CLAUDE_CODE_OAUTH_TOKEN`.
   It is long-lived access to your whole Claude account — it never leaves `.env`,
   which is gitignored.
3. Create a Discord incoming webhook (Server Settings → Integrations → Webhooks →
   New Webhook → Copy Webhook URL) and paste it into `DISCORD_WEBHOOK_SMOKE`.
4. `docker compose up --build`

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

## Development

- `npm test` — full suite, consumes no quota
- `npm run typecheck`
- `npm run probe` — **one real Haiku call**; prints raw SDK messages and proves authentication works

## Things worth knowing before you trust it

**`status: "success"` means the SDK finished without erroring — not that the agent
achieved its objective.** A run can return a well-formed answer and still have
failed to do the thing. Nothing here verifies outcomes yet. Read the transcripts
early on.

**Every run has a fixed cost floor** (~$0.046-equivalent, measured): the SDK loads
all tool definitions into the system prompt regardless of `allowedTools`, which
governs auto-approval, not what is loaded. Set `maxBudgetUsd` well clear of it or
runs get truncated mid-task. On a subscription these are estimates, not money —
but `maxBudgetUsd` is the SDK's stop mechanism and uses the same units.

**Agents share one rate limit with your own interactive Claude use.** The SDK
reports live utilisation via `rate_limit_event`; enforcing against it is Plan B's
governor. Until then, the `quietHours` block in `config.yaml` is parsed but inert,
and the boot log says so.

**Tool calls need absolute paths.** An agent prompt that says "read `notes.md` in
your working directory" will fail its first tool call. Say so explicitly in the
prompt, and give the agent `Glob` so it can locate itself.

## Not built yet

The governor (budgets, concurrency, quiet hours), capability tiers and grants, the
Discord control bot with approvals, park/resume, git-based deploy, and browser
control. See the design doc's roadmap.
