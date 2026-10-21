// One line for a thrown value, keeping a DOMException's name: on-device, the name
// (DataCloneError, NotSupportedError, …) is what separates one browser failure from another.
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err !== 'object') return String(err);
  const { name, message } = err as { name?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (typeof name !== 'string' || !name || name === 'Error') return text || String(err);
  return text ? `${name}: ${text}` : name;
}
