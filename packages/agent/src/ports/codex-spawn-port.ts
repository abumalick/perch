// What a Codex spawn needs from the machine: the versions of the CLI and of the app-server
// daemon, and a daemon thread started on the brief.
export interface CodexSpawnPort {
  versions(): Promise<{ cli: string; appServer: string }>;
  createThread(input: { cwd: string; model?: string; developerInstructions?: string; firstMessage: string }): Promise<string>;
}
