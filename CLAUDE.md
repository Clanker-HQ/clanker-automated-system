# Working preferences for this project

**Bias toward maximum automation. The human should almost never be in the
loop.** When designing or extending an agent, default to `tier: autonomous`
+ `approval: auto` with a properly scoped grant, not `park`/`notify`, unless
the action is genuinely high-risk (spending real money beyond budget,
pushing/merging code, provisioning infrastructure) — those still go through
the existing grant/tier/Governor system, which is how "automatic" and "safe"
coexist here rather than being in tension. Read-only work, research, and
proposing/queuing tasks should never need a human approval step just to
happen. The human's involvement should be reviewing outcomes after the fact
(Discord notifications, the daily digest, `!tasks`/`!result`), not gating
each individual action before it runs.

This is a standing preference — don't ask again whether to reduce
approval friction; assume yes and design for it, and only raise it back to
the human when a specific action is genuinely irreversible or costly enough
to warrant it.
