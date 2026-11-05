import type { ServeConfig, TailscaleStatus } from '../application/setup-machine';

export interface TailscalePort {
  // Null when Tailscale is not installed or its daemon does not answer.
  status(): Promise<TailscaleStatus | null>;
  serveStatus(): Promise<ServeConfig | null>;
  // Adds one handler (`tailscale serve`, or `tailscale funnel` to also publish it), leaving the
  // node's other handlers as they are. Throws TailscaleOperatorError when Tailscale refuses for
  // want of root or an operator.
  serve(entry: { port: number; path: string; target: string; funnel: boolean }): Promise<void>;
}

export class TailscaleOperatorError extends Error {}
