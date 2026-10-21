// The rear camera, decoding QR codes frame by frame until stopped. The decoder is loaded on
// first use, so it costs the app nothing until someone scans.
export type QrScan = (video: HTMLVideoElement, onText: (text: string) => void) => Promise<() => void>;

export const scanQrCodes: QrScan = async (video, onText) => {
  const { QRCanvas, frameLoop, rearCamera } = await import('qr/dom.js');
  // iOS plays a camera stream inline only on a muted, inline video.
  video.muted = true;
  video.playsInline = true;
  const camera = await rearCamera(video);
  const canvas = new QRCanvas();
  let busy = false;
  let stopped = false;
  const cancel = frameLoop(() => {
    if (busy || stopped) return;
    busy = true;
    camera.readFrame(canvas).then(
      (result) => {
        busy = false;
        if (!stopped && typeof result === 'string') onText(result);
      },
      () => {
        busy = false;
      },
    );
  });
  return () => {
    stopped = true;
    cancel();
    camera.stop();
  };
};
