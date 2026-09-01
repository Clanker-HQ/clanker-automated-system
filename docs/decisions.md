# Architectural decisions & accepted risks

This is the permanent home for design rationale that used to live scattered
across the per-project spec/plan documents this repo carried during
development (`docs/superpowers/specs/`, `docs/superpowers/plans/`). Those were
deleted once every project they described had shipped and merged — the code,
tests, and README are the record of *what* was built. This file is the record
of *why*, kept because it's still actively read: by `improvement-scout` (see
`agents/improvement-scout/prompt.md`), so it doesn't re-propose an idea
already considered and rejected, and by code comments citing the reasoning
behind a specific safety mechanism.

For what's still not built at all, see README's "Not built yet" section —
this file explains past decisions, not the remaining backlog.

## Rejected architectural alternatives

**Managed Agents** (Anthropic's hosted scheduled-agent product). Does what
this platform does, with Anthropic hosting the loop and sandbox — but bills
against the API, which conflicts with running on a Claude subscription (see
below). Worth revisiting only if billing ever moves to the API.

**One container per run.** Kernel-level isolation per run needs Docker socket
access from the supervisor (equivalent to host root), plus an image pipeline
and slow cold starts — disproportionate for one operator running their own
agents. Chosen instead: one container, one supervisor, agents separated by
workspace directory, per-agent tool permissions, and capability tier. The
`Runner` interface (`src/runner/types.ts`) is the seam where per-run isolation
could be adopted later if this changes.

## Subscription billing, not API billing

`claude setup-token` mints a subscription-backed OAuth token (`src/runner/credentials.ts`);
no API billing occurs by default. Anthropic doesn't permit offering claude.ai
login/rate limits to a third-party product's *end users* without prior
approval — running agents for oneself, on one's own subscription, is the
intended use, and no user-facing product is planned. Credential resolution is
isolated in one module so a future move to API-key billing stays a config
change, not a rewrite; `ALLOW_API_BILLING=true` is the explicit, deliberate
opt-out.

## A deployed product never uses the operator's Claude subscription

"Subscription billing, not API billing" above grounds that choice partly on
"no user-facing product is planned." The deploy path
(`docs/superpowers/specs/2026-09-01-deploy-path-design.md`) introduces
exactly that, so the reasoning needs a carve-out, not a reversal: the
supervisor itself still runs on the operator's subscription — nothing about
running *this system's own* agents changed — but no deployed product ever
does. Anthropic doesn't permit offering claude.ai login or rate limits to a
third-party product's end users, and `goals.yaml`'s `means` forbid violating
a service's terms regardless.

What replaced it: a product that needs a model gets its own paid API key,
from whichever provider `research` selects for it per product — cost,
capability, and whether that provider's terms even permit the use. Nothing
in the product path is Anthropic-specific. `deploys.yaml`'s `env` field is
the seam: an entry names the variable *names* its container needs; the
values live only in the host's product environment file and never enter the
supervisor's container, so a product receives only what its own entry
declared and never another product's key. See design §7.

## Accepted risk: the PR reviewer runs a PR's code directly, with its own live credentials

`pr-reviewer` executes a PR's code (e.g. `npm test`) in its own environment,
using its own GitHub token — not in an isolated, credential-free sandbox.
`canUseTool` mediates individual tool calls an agent's own reasoning decides
to make; it does not extend inside an already-permitted subprocess. So a
hostile or buggy PR's code, once running, could in principle read and
exfiltrate the reviewer's own GitHub token.

**The bound:** a stolen token is still *the bot's own GitHub identity*.
`touchesExcludedPath`'s Lock 4 (`src/control/excluded-paths.ts`), plus
GitHub's own CODEOWNERS/branch protection, restrict *who* can merge — not
which credential string authenticated as them — so both hold even against a
stolen token. Worst case: an attacker who gets a hostile PR opened can get it
merged without passing review, but still cannot touch the excluded
security-sensitive paths.

**A related, narrower gap:** `pr-reviewer` has `Bash`, and `detectOutwardEffect`
(`src/grants.ts`) doesn't recognize `gh pr merge` or `gh pr review` as outward
effects (bare `git push` now is, added later to back `builder`'s `git-push`
grant). So an agent that shells out to `gh pr merge` — whether by its own
error or hijacked by content injected in the PR it's reviewing — bypasses
`mergePR`'s gates entirely, Lock 4 included. Same bound as above:
CODEOWNERS/branch protection still restrict who merges. Closing this properly
means either extending `detectOutwardEffect` to recognize these Bash-invoked
patterns (a fragile string-match boundary) or narrowing `Bash`'s scope for
this agent specifically — not done, and not an oversight.

## Design choice: the scouts ship without a critic/quality-filter step

`opportunity-scout` and `improvement-scout` self-generate tasks with no
review step gating what they propose. The obvious risk with self-generating
task queues is low-value, plausible-sounding busywork with nothing checking
whether a proposal is worth doing. Shipped anyway, bounded by:

- a hard frequency cap (≤3 tasks/run, once/day/scout — ≤6/day total)
- cost capped by the same Governor as every other run
- a low-value proposal costs one bounded `research` run, or just sits unread
  in `!tasks` — not a repeating liability, not something that compounds

A critic step is a natural, isolated follow-up if scout output quality
becomes a real problem in practice — it would slot in between `queueTask`
being called and the task actually persisting, without touching anything
else built here. Not built because it wasn't needed to prove the core loop,
not because it was overlooked.

## Auto-deploy runs host-side, not agent-side

`scripts/auto-deploy.sh` (cron/systemd on the VPS host) is what closes the
loop from "PR merged" to "actually live" — pull, rebuild, verify Docker's
own `HEALTHCHECK` reports healthy, roll back to the previous commit if it
doesn't. It is deliberately a plain host script, not a tool any agent can
call.

**Why not give an agent this ability directly:** triggering a redeploy from
inside a container means either mounting the Docker socket into that
container (close to host-root — a far bigger blast radius than anything
else this system grants) or giving the agent SSH/exec access to the host
itself. The deploy step needs no judgment — "did the default branch move"
is a fact, not a decision — so there is nothing to gain from putting it
inside the agent trust boundary at all.

**Why this is safe to run unattended, with no human approving each
deploy:** `EXCLUDED_PATHS` already keeps every merge through the automated
pipeline from touching the governance/safety code itself, regardless of
deploy automation — the worst a bad auto-deployed change can do is break a
*feature*, never the safety mechanisms. As of the self-build merge gate,
this is narrower than it reads: safety **code** (everything actually listed
in `EXCLUDED_PATHS`/`EXCLUDED_PREFIXES`) still can never change through the
pipeline, but governance **data** (`grants.yaml`, `agents/*/agent.yaml`) now
can, bounded by `src/control/self-build-gate.ts`'s four mechanical rules
rather than by an outright refusal. CI already gates every PR on
typecheck + tests before merge is even possible. The one genuinely new
failure mode — a change that passes CI but breaks at runtime — is what the
health-check-and-rollback exists to catch algorithmically, the same
philosophy as everything else in this project: the safety net is a
code-level check, not a person watching each deploy happen.
