// The environment the agent hands a child process. The agent's own env holds deploy/agent.env
// (PERCH_TOKEN enrols phones), and a tmux server started by the agent copies the env it was
// started with into its global environment, which every pane, every Claude session and
// everything they run inherits. Nothing a child runs needs a PERCH_ variable: the hook script
// takes its port as an argument and its secret from ~/.perch/token.
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith('PERCH_')) out[name] = value;
  }
  return out;
}
