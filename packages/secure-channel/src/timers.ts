// A one-shot timer that hands back its own cancel: the default wherever a timer is injected.
export function startTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}
