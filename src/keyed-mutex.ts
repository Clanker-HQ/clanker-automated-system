/**
 * Serializes async work per key, within this one process. TaskStore.update()
 * and ConfigOverridesStore.set() both do read-whole-file -> mutate ->
 * write-whole-file with no other protection — two calls racing on the same
 * file (the dispatcher's tick and a Discord `!cancel`/`!retry`/`!disable` all
 * touch these same files) can otherwise read the same "before" state and have
 * the later write silently clobber the earlier one's change.
 *
 * Deliberately in-process only: this project runs as one supervisor process
 * per data directory, so a cross-process lock (a lockfile, an OS-level flock)
 * would be solving a problem this deployment doesn't have.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let releaseOurs!: () => void;
    const ourTurnDone = new Promise<void>((resolve) => {
      releaseOurs = resolve;
    });
    // Whoever queues in after us awaits `chained`, which only resolves once
    // BOTH `previous` and our own `fn()` (via `ourTurnDone`) have settled —
    // that's what actually serializes each key's callers one at a time.
    const chained = previous.then(() => ourTurnDone);
    this.chains.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      releaseOurs();
      // Only clear the entry if nothing queued in behind us while we ran —
      // otherwise this would delete THEIR chain out from under them.
      if (this.chains.get(key) === chained) this.chains.delete(key);
    }
  }
}
