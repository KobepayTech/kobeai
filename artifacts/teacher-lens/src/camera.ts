import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Camera hook — starts a rear-facing video stream + gives back a
// captureFrame() that returns a data URL. The captured image is optional
// (server accepts the structured event without it) but ready for a future
// wire-up to /v1/teacher-lens/frame.
// ---------------------------------------------------------------------------
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setReady(true);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  const captureFrame = useCallback((): string | null => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, []);
  // Frames are scaled down so the K9 models answer faster on a school PC.
  const captureBlob = useCallback(async (maxSide = 1600): Promise<Blob | null> => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) return null;
    const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.75),
    );
  }, []);
  return { videoRef, ready, err, captureFrame, captureBlob };
}
