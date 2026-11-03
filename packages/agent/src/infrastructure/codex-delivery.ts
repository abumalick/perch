import type { DeliveryTarget, MessageDelivery } from '../ports/message-delivery-port';
import { CodexAppServerDown, type CodexAppServer } from './codex-app-server';

export type CodexThreads = Pick<CodexAppServer, 'loadedThreads' | 'threadState' | 'startTurn' | 'steer'>;

type Result = { ok: true } | { ok: false; reason: string };

// The daemon's answers when the running turn changed between our read and the steer: the turn
// moved on, or ended.
const RACE = /^(expected active turn id |no active turn to steer)/;

class NoTurnToSteer extends Error {
  constructor() {
    super('the thread is busy with no turn to steer');
  }
}

// Delivers into a Codex thread the app-server daemon holds: a new turn when the thread is idle,
// a steer into the running turn otherwise. A thread the daemon has not loaded is a Codex that
// holds it in-process (embedded, or --no-daemon), which nothing outside can reach.
export class CodexDelivery implements MessageDelivery {
  constructor(private readonly codex: CodexThreads) {}

  async deliver(target: DeliveryTarget, text: string): Promise<Result> {
    const thread = target.codexThread;
    if (!thread) {
      return {
        ok: false,
        reason: `no Codex thread recorded for ${target.id} (only perch spawn --cli codex workspaces take messages)`,
      };
    }
    try {
      if (!(await this.codex.loadedThreads()).includes(thread)) {
        return { ok: false, reason: `the Codex thread of ${target.id} is not open` };
      }
      try {
        await this.post(thread, text);
      } catch (err) {
        if (!(err instanceof NoTurnToSteer) && !RACE.test((err as Error).message)) throw err;
        await this.post(thread, text);
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof CodexAppServerDown) return { ok: false, reason: err.message };
      return { ok: false, reason: `the Codex app server failed: ${(err as Error).message}` };
    }
  }

  private async post(thread: string, text: string): Promise<void> {
    const state = await this.codex.threadState(thread);
    if (state.status === 'idle') return this.codex.startTurn(thread, text);
    if (!state.activeTurnId) throw new NoTurnToSteer();
    return this.codex.steer(thread, text, state.activeTurnId);
  }
}
