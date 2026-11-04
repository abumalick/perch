export const load = {
  cpu: 'CPU',
  ram: 'RAM',
  left: ' left',
  beforeKill: (kill: string) => `· ${kill} before kill`,
  help: 'What these numbers mean',
  dismiss: 'Dismiss',
  slowTitle: (slow: string) => `${slow} left`,
  slowBody: (warn: string, alert: string) =>
    ` — what a new task can take before this machine slows down. Past that it has to push memory out to disk. Green above ${warn}, amber below it, red under ${alert}.`,
  killTitle: (kill: string) => `${kill} before kill`,
  killBody:
    ' — what can be taken before the kernel kills a process to make room. The machine is already slow well before that.',
  cache: 'Files the kernel keeps cached count as free in both figures: it drops them whenever the memory is needed.',
  killsTitle: (n: number) => `${n} killed`,
  killsBody:
    ' — processes the kernel stopped since this app connected. It picks by OOM score, which is often a helper rather than your session, so this can look like tooling breaking rather than a workspace disappearing.',
  done: 'Done',
};
