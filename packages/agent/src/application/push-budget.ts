const WINDOW_MS = 60_000;
const PUSHES_PER_MINUTE = 10;

// How often one device key may be served at once (authResult and the workspace list right behind
// message 2). Message 1 can be replayed by the relay, and each replay would make the agent build
// the list again; past the budget a phone is served the old way, after its `auth`. Keyed by
// enrolled device keys only, so it stays as small as the roster.
export class PushBudget {
  private readonly taken = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly perMinute = PUSHES_PER_MINUTE,
  ) {}

  take(deviceKey: string): boolean {
    const now = this.now();
    const recent = (this.taken.get(deviceKey) ?? []).filter((t) => now - t < WINDOW_MS);
    const allowed = recent.length < this.perMinute;
    if (allowed) recent.push(now);
    this.taken.set(deviceKey, recent);
    return allowed;
  }
}
