import { toPcm16 } from '../core/pcm';
import type { PcmSource } from '../core/ports/pcm-source';
import { AUDIO_CONSTRAINTS } from './media-recorder-audio';

// Microphone PCM from Web Audio, the same on WebKit and Blink (MediaRecorder's containers are
// not: Safari's MP4 cannot be decoded until it is finished). The context is created before
// the first await so it starts inside the tap that asked for it, which iOS requires.
// ScriptProcessorNode is deprecated but needs no worklet module, which the CSP would have to allow.
export class WebAudioPcm implements PcmSource {
  private stopCapture: (() => void) | null = null;
  // Bumped by every start and stop, so a start that a stop overtook releases what it opened.
  private generation = 0;

  async start(onPcm: (pcm: Uint8Array) => void): Promise<void> {
    this.stop();
    const generation = this.generation;
    const ctx = new AudioContext();
    let stream: MediaStream;
    try {
      void ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
    } catch (e) {
      void ctx.close();
      throw e;
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      throw new Error('Dictation was stopped');
    }
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => onPcm(toPcm16(e.inputBuffer.getChannelData(0), ctx.sampleRate));
    source.connect(processor);
    // A processor only runs while connected to the output; it writes nothing, so it is silent.
    processor.connect(ctx.destination);
    this.stopCapture = () => {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
    };
  }

  stop(): void {
    this.generation++;
    this.stopCapture?.();
    this.stopCapture = null;
  }
}
