export interface AgentServicePort {
  // Returns the command it ran, for the report.
  restart(): Promise<string>;
}
