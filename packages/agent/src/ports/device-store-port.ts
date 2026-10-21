import type { DeviceRoster } from '../application/device-roster';

// The phones this agent accepts through the relay (~/.perch/devices.json), shared by every
// checkout like deploy/agent.env. Read fresh on every call, so a `perch devices` edit takes
// effect at the next handshake with no restart.
export interface DeviceStorePort {
  read(): Promise<DeviceRoster>;
  // Read, change and write back in one step; returns what was written.
  update(change: (roster: DeviceRoster) => DeviceRoster): Promise<DeviceRoster>;
}
