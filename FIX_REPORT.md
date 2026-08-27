# Fix: per-run grant approval persistence

## The bug

A `tier: granted` agent parked for approval on an outward effect (e.g. `curl
https://httpbin.org/post` matching a `test-echo` HTTP grant). A human
approved via Discord, `Orchestrator.resumeRun` resumed the same SDK session
with "Approved. Continue.", and the model retried the same tool call to
finish its task. That retried call went through `canUseTool` fresh:
`decide()` re-evaluated it with no memory of the prior approval, matched the
same grant, and parked again with a new pending id. Live result: an infinite
approve -> resume -> retry -> park loop in Discord.

Root cause: nothing threaded a "this grant was approved this run" signal
from a resolved approval back into a later `canUseTool` decision. `decide()`
is a pure, static function of `agent.tier`/`grantRefs`/`approval` — it has
no notion of run-time approval history, and nothing else supplied one.

## The fix

Approving a grant now marks it approved for the **rest of that run** (not
permanently, not for other agents/runs). A later `canUseTool` call for the
same grant, even after further park/resume cycles in the same run, is
allowed straight through instead of parking again.

### 1. New store — `src/state/approved-grants.ts` (new file)

`ApprovedGrantsStore`, matching `src/state/breaker.ts` / `src/state/rate-limit.ts`'s
shape exactly: `read(runId)` returns `[]` on no/unreadable file (never
throws), `approve(runId, grantRef)` is idempotent (no duplicate entries) and
persists to `data/runs/<runId>/approved-grants.json` — the same
already-created `runs/<runId>/` directory `RunStore` uses for
transcript/result, so it needs no separate cleanup story.

Tests: `tests/approved-grants.test.ts` (5 tests, mirroring
`tests/breaker.test.ts`'s house style: unknown run -> `[]`, approve/read
round-trip, idempotent duplicate approval, two grants accumulate, survives a
simulated restart via a fresh instance over the same directory).

### 2. `RunContext` gains `approvedGrantRefs?: string[]`

`src/runner/types.ts:19-33`. Documented as: ids approved earlier in this
same run; absent on a fresh (non-resumed) run.

### 3. `SdkRunner.canUseTool` bypasses the park path for an already-approved grant

`src/runner/sdk-runner.ts:246-256`, inserted between the existing `deny`
branch and the park-and-`pending.create()` logic:

```ts
if (ctx.approvedGrantRefs?.includes(decision.grantRef)) {
  return { behavior: "allow" };
}
```

Pure bypass in `SdkRunner` (where `ctx` is in scope) — no pending entry is
written, no `terminalEvent` is set, no abort happens. `decide()`/`src/grants.ts`
is untouched and stays a static, per-call decision function unaware of
approval history, per the task's instruction.

Tests added to the existing `describe("SdkRunner grant enforcement", ...)`
block in `tests/sdk-runner-options.test.ts`:
- `"allows a matching-grant effect straight through, without parking, when
  the grant is already in ctx.approvedGrantRefs"` — asserts `{behavior:
  "allow"}`, an empty `PendingStore`, and no `"parked"` event.
- `"still parks and writes a pending entry when approvedGrantRefs is
  absent"` — confirms original behavior is unchanged (the task said this
  should already be covered by existing tests; I added an explicit one
  anyway since none of the existing tests exercise `canUseTool` with the new
  field literally absent from a variable named for that purpose — cheap
  insurance, not a duplicate of "parks and writes a pending entry..." which
  predates this field entirely).
- `"still parks when approvedGrantRefs is present but does not include the
  matched grant"` — proves the bypass is scoped to the specific grant, not a
  blanket allow once any approval exists.

### 4. `Orchestrator.resumeRun` persists the approval and forwards the accumulated list

`src/orchestrator.ts`:
- Constructor gains a required `approvedGrants: ApprovedGrantsStore` field
  (lines 8, 18, 28, 43).
- In `resumeRun` (lines 105-122), after the governor admits the resume and
  before building the `RunContext`:
  ```ts
  if ("approved" in decision && decision.approved && entry.grantRef) {
    await this.approvedGrants.approve(entry.runId, entry.grantRef);
  }
  const approvedGrantRefs = await this.approvedGrants.read(entry.runId);
  ```
  then `approvedGrantRefs` is included in the `RunContext` passed to
  `runAndRecord`. The persist-then-read ordering means a resume that is
  itself an approval includes its own newly-approved grant in what the
  resumed run sees — not just approvals from previous resumes.
- `executeRun` (fresh-trigger path) is untouched: it doesn't pass
  `approvedGrantRefs` at all, so it's `undefined` on a fresh run, which
  `ctx.approvedGrantRefs?.includes(...)` handles safely.

Tests added, new `describe("Orchestrator.resumeRun grant approval
persistence", ...)` block in `tests/orchestrator.test.ts` (placed after the
"onParked announcement hook" block), using the existing `harness()` helper
extended to also return a real `ApprovedGrantsStore` over the same data dir
(so the test proves the fix through the real store, matching how "Orchestrator
+ a real circuit breaker" tests the breaker):
- `"persists an approved grant and forwards it in the resumed run's
  RunContext"` — approves via `resumeRun({approved: true})`, reads the store
  directly, and inspects the `RunContext` (second arg) the spied
  `runner.execute` actually received.
- `"accumulates approvals across sequential resumes of the same run"` — two
  sequential `resumeRun` calls on the same `runId` approving `"a"` then
  `"b"`; asserts the store holds `["a", "b"]` and the *second* resume's
  `RunContext.approvedGrantRefs` contains both — this is the exact scenario
  that was looping live.
- `"does not persist anything when the resume decision is a denial"` — a
  `{approved: false}` resume leaves the store empty for that run.

### 5. Wiring — `src/index.ts` and `scripts/probe-e2e-approval.ts`

Both construct `const approvedGrants = new ApprovedGrantsStore(DATA_DIR);`
alongside the other stores and pass it into their `Orchestrator({...})` call
(`src/index.ts:19,84,115`; `scripts/probe-e2e-approval.ts:30,67,83`). The
probe mirrors `index.ts`'s wiring by design, per the task description, so
re-running it after this fix should show the retried `curl` sail through
instead of parking a second time.

## Judgment calls / deviations from the task description

1. **`Orchestrator` constructor field is required, not optional.** Making
   `approvedGrants` required (as the task explicitly asked) meant every
   existing `new Orchestrator({...})` call site had to be updated to compile
   — there were **16** in `tests/orchestrator.test.ts` alone (plus
   `src/index.ts` and `scripts/probe-e2e-approval.ts`), not just the ones
   the task called out. 9 of them shared byte-for-byte identical
   construction code (`dataDir: "unused", ... breaker: new
   BreakerStore(mkdtempSync(...))`), so I extended that repeated fragment
   with `approvedGrants: new ApprovedGrantsStore(mkdtempSync(join(tmpdir(),
   "cai-orch-appr-")))` via a single `replace_all` edit; the other 7
   (`harness()`, the "still returns a successful RunResult..." test, the
   governor-refuses test using `store["dataDir"]`, the "refuses to resume...
   no sessionId" test, `parkHarness`, and `realHarness`'s two construction
   sites) each got a tailored one-off edit using the real data dir already
   in scope in that test, rather than a throwaway directory, since some of
   those tests exist specifically to prove behavior across real stores.
   `harness()` and `realHarness()` also now return their
   `ApprovedGrantsStore` instance so the new persistence tests can assert
   against it directly.
2. **The task's described `decide()`/`canUseTool`/`resumeRun` shapes matched
   the real code closely** — the retrieved-from-disk versions of `grants.ts`,
   `sdk-runner.ts`, and `orchestrator.ts` were consistent with the
   description (park decisions carry `grantRef`; `resumeRun` already builds
   `prompt` the way described; `PendingEntry.grantRef` is optional exactly as
   assumed for the `entry.grantRef` guard). No structural surprises to note
   beyond the constructor-field fan-out above.
3. **One extra guard test** ("still parks and writes a pending entry when
   approvedGrantRefs is absent") was added despite the task suggesting this
   might already be covered — I checked and no existing test exercises
   `canUseTool` against a `ctx` that literally lacks the new field by name,
   so I added a minimal one rather than assume coverage.

## Verification

- `npm run typecheck` — passes, no errors.
- `npm test` — **19 test files, 260 tests, all passing** (up from the
  pre-fix suite; 11 new tests added: 5 in `tests/approved-grants.test.ts`,
  3 in `tests/sdk-runner-options.test.ts`, 3 in `tests/orchestrator.test.ts`).

```
 Test Files  19 passed (19)
      Tests  260 passed (260)
```

## Files touched

- `src/state/approved-grants.ts` (new)
- `tests/approved-grants.test.ts` (new)
- `src/runner/types.ts`
- `src/runner/sdk-runner.ts`
- `tests/sdk-runner-options.test.ts`
- `src/orchestrator.ts`
- `tests/orchestrator.test.ts`
- `src/index.ts`
- `scripts/probe-e2e-approval.ts`
