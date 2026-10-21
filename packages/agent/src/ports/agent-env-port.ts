export interface AgentEnvPort {
  path: string;
  read(): Promise<string>;
  // Backs the current file up first; returns the backup's path.
  write(text: string): Promise<string>;
}
