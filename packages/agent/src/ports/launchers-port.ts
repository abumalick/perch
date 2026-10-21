export interface LaunchersPort {
  // The custom commands launched on this machine before, oldest first.
  list(): Promise<string[]>;
  remember(command: string): Promise<void>;
  forget(command: string): Promise<void>;
}
