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
5. `docker compose up --build`

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

**Agents share one rate limit with your own interactive Claude use.** The
governor is live: it enforces `maxConcurrent`, `dailyBudgetUsd`, `quietHours`,
and a circuit breaker, and admits runs with an eye on the SDK's own
`rate_limit_event` utilisation reporting. A run that can't be admitted right
now is parked, not silently dropped or force-run over your interactive quota.

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

**Tool calls need absolute paths.** An agent prompt that says "read `notes.md` in
your working directory" will fail its first tool call. Say so explicitly in the
prompt, and give the agent `Glob` so it can locate itself.

## Not built yet

The governor, capability tiers and grants, park/resume, and the Discord control
bot (approvals, questions, admin commands) are all built and live as of Plan B.
Still genuinely deferred:

- **The builder agent, git-based deploy, and the "proposal approval" Discord
  flow** — an agent writing a new `agent.yaml`, the supervisor pulling and
  validating it, and asking to merge it. Nothing produces a proposal branch
  yet, so there's nothing for the deploy/approval machinery to act on.
- **Outcome verification.** `status: "success"` still only means the SDK
  didn't error, not that the agent's objective was achieved (see above).
- **Browser capability** (`capabilities.browser`) — Plan C territory.
- **Any real grant.** `grants.yaml` ships one synthetic grant (`test-echo`,
  a POST to `httpbin.org`) to exercise tier/grant enforcement end to end;
  wiring up an actual credentialed effect (a repo push, a real API call)
  happens later, agent by agent, as a real need shows up.

See the design doc's roadmap for how these fit together.
