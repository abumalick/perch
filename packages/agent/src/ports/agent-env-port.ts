export interface AgentEnvPort {
  path: string;
  read(): Promise<string>;
  // Backs the current file up first; returns the backup's path, or null when there was no file.
  write(text: string): Promise<string | null>;
}
