// The environment the agent hands a child process. The agent's own env holds deploy/agent.env
// (TARFA_TOKEN enrols phones), and a tmux server started by the agent copies the env it was
// started with into its global environment, which every pane, every Claude session and
// everything they run inherits. Nothing a child runs needs a TARFA_ variable, nor the PERCH_ one
// an agent.env not rewritten yet still names: the hook script takes its port as an argument and
// its secret from ~/.tarfa/token.
export function childEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith('TARFA_') && !name.startsWith('PERCH_')) out[name] = value;
  }
  return out;
}
