import type { Pairing } from '../application/pairing';

// The phone pairing secrets this machine has handed out (~/.perch/pairing.json). `perch pair`
// adds to it from one process and the agent redeems from another, so updates are atomic.
export interface PairingStorePort {
  read(): Promise<Pairing[]>;
  update(change: (list: Pairing[]) => Pairing[]): Promise<Pairing[]>;
}
