// The agent's service definition: a systemd user unit on Linux, a launchd agent on macOS.
export interface ServiceInstallPort {
  kind: 'systemd' | 'launchd';
  // The checked-in template, with REPO_PATH where the checkout goes.
  template(): Promise<string>;
  // The installed unit or plist, or null when none is.
  installed(): Promise<string | null>;
  // Whether it is enabled to start at boot (and, under systemd, linger is on).
  enabled(): Promise<boolean>;
  // Writes it, enables it at boot; returns what it ran, for the report.
  install(text: string): Promise<string[]>;
}
