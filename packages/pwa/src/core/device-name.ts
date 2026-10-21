// A short label for this device, sent to the agent when it enrols the device key so that
// `perch devices` can tell phones apart. Informative only; the key is what is checked.
export function deviceName(userAgent: string): string {
  const platform =
    /iPad/.test(userAgent) ? 'iPad'
    : /iPhone/.test(userAgent) ? 'iPhone'
    : /Android/.test(userAgent) ? 'Android'
    : /Macintosh/.test(userAgent) ? 'Mac'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'Device';
  const browser =
    /EdgA?\//.test(userAgent) ? 'Edge'
    : /Firefox\/|FxiOS/.test(userAgent) ? 'Firefox'
    : /Chrome\/|CriOS/.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'browser';
  return `${platform} · ${browser}`;
}
