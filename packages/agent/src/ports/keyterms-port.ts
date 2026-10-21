export interface KeytermsPort {
  // The dictation vocabulary the PWA passes to ElevenLabs, in file order. Empty when the
  // config file is absent — dictation then runs with no vocabulary hints.
  list(): Promise<string[]>;
}
