// The microphone as a live stream of 16 kHz PCM blocks (see core/pcm.ts). `start` resolves
// once capture runs; blocks reach `onPcm` only after that. Faked in tests.
export interface PcmSource {
  start(onPcm: (pcm: Uint8Array) => void): Promise<void>;
  stop(): void;
}
