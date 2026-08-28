# Configuring the system

Two layers: `config.yaml` sets the defaults on disk; Discord commands set
**live overrides** on top, without editing or redeploying anything. An
override wins over `config.yaml` until you change it back, and survives a
restart (stored in `data/config-overrides.json`).

## Discord commands (live, no redeploy)

Send these in the bot's channel.

| Command | Effect |
|---|---|
| `!budget <n>` | Daily spend ceiling in USD, e.g. `!budget 25` |
| `!quiet HH:MM-HH:MM Area/City` | Set quiet hours, e.g. `!quiet 02:00-03:00 Europe/Berlin` |
| `!quiet off` | Disable quiet hours |
| `!breaker off` | Disable the circuit breaker (a tripped agent stops refusing triggers) |
| `!breaker on` | Re-enable it |
| `!concurrency <n>` | How many runs may be in flight at once |
| `!disable <agent>` | Stop triggering one agent |
| `!enable <agent>` | Re-enable it, and reset its circuit breaker |
| `!stop` | Hard stop — no new runs or resumes at all, until `!resume` |
| `!resume` | Undo `!stop` |
| `!runs` | Last 20 runs — id, status, cost |
| `!status` | One-shot snapshot of everything above, plus budget spent today and task counts |
| `!task [-d] [-p <n>] <text>` | Queue a free-form request; `-d` for a longer summary back, `-p <n>` for its priority (default 50) |
| `!tasks` | Tasks not yet finished |
| `!result <id-or-prefix>` | Look up any task, finished or not, by full id or short prefix |
| `!retry <id-or-prefix>` | Requeue a failed task |
| `!cancel <id-or-prefix>` | Remove a still-pending task |

### "This runs on its own dedicated Claude subscription, don't budget-limit it"

```
!quiet off
!budget 999999
!breaker off
```

Together these make the governor's usage-related checks a no-op. `!stop`
deliberately isn't part of this set — it's your manual kill switch, not an
automatic limit, so it always still works.

## `config.yaml` (the defaults these overrides start from)

```yaml
governor:
  maxConcurrent: 2          # runs in flight at once
  dailyBudgetUsd: 10        # daily spend ceiling in USD
  pendingTimeoutHours: 24   # an unanswered approve/deny/question older than this is auto-denied at the next restart
  quietHours: { from: "02:00", to: "03:00", timezone: Europe/Berlin }

discord:
  channels:      { smoke: DISCORD_WEBHOOK_SMOKE }      # webhook URL, routine reports
  botChannels:   { smoke: DISCORD_CHANNEL_ID_SMOKE }   # channel id, for the bot commands above

digest:
  enabled: true
  schedule: "0 8 * * *"   # once a day, croner's 5-field cron syntax
  timezone: Europe/Berlin
  channel: smoke          # a key into discord.channels

retention:
  enabled: true
  days: 30                # delete run data / workspace files older than this
  schedule: "0 4 * * 0"   # weekly (Sunday 04:00)
  timezone: Europe/Berlin
  channel: smoke
```

Edit this file only for the *baseline* you want across restarts. For a
one-off or temporary change, use the Discord commands instead — no restart
needed, and it's reversible from your phone. `digest`/`retention` have no
Discord equivalent — they only ever run on their own schedule, so a
`config.yaml` edit + restart is the only way to change them.

## Things that are NOT configurable via Discord (edit + redeploy required)

- Adding/removing agents, or what an agent is allowed to do (`agents/*/agent.yaml`, `grants.yaml`)
- Discord channel/webhook wiring (`config.yaml`'s `discord:` block, plus the env vars it names)
- The owner id allowed to use any of this (env var, checked once at boot)
- The daily digest and weekly data-retention sweep (`digest:`/`retention:` in `config.yaml`)
