import { useEffect, useRef, useState } from "react";

// Two ways to ask that are not typing: photograph a question, or draw your
// working. Both matter in a Tanzanian classroom — a textbook question is
// faster photographed than typed, and a child who cannot express an algebra
// step in words can usually write it down.
//
// Both produce a base64 JPEG for /v1/student/scan. The image is read by the
// school's own runtime and never leaves the school.

const MAX_EDGE = 1400;

/** Downscale before upload: a modern tablet photo is far larger than OCR needs. */
async function toJpeg(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This tablet cannot prepare the image.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
}

export function ScanQuestion({
  onCapture,
  onCancel,
}: {
  onCapture: (image: string, kind: "question" | "working") => void;
  onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"question" | "working">("question");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = media;
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play().catch(() => undefined);
        }
      } catch {
        setError("K9 could not open the camera. You can type your question instead.");
      }
    })();
    return () => {
      cancelled = true;
      // Always release the camera. A tablet left with the light on is both a
      // battery problem and, in a classroom, an unsettling one.
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
    };
  }, []);

  return (
    <div className="capture">
      <div className="capture-choice" role="group" aria-label="What are you photographing?">
        <button aria-pressed={kind === "question"} onClick={() => setKind("question")}>
          A question
        </button>
        <button aria-pressed={kind === "working"} onClick={() => setKind("working")}>
          My working
        </button>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : (
        <video ref={video} playsInline muted aria-label="Camera" />
      )}
      <div className="capture-actions">
        <button onClick={onCancel} className="ghost">
          Cancel
        </button>
        <button
          disabled={!!error}
          onClick={async () => {
            const element = video.current;
            if (!element || !element.videoWidth) return;
            try {
              onCapture(await toJpeg(element, element.videoWidth, element.videoHeight), kind);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not take that photo.");
            }
          }}
        >
          Take photo
        </button>
      </div>
    </div>
  );
}

export function DrawWorking({
  onCapture,
  onCancel,
}: {
  onCapture: (image: string, kind: "question" | "working") => void;
  onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [used, setUsed] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // Match the backing store to the CSS size, or strokes land away from the
    // finger on a high-density screen.
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const rect = element.getBoundingClientRect();
    element.width = Math.round(rect.width * ratio);
    element.height = Math.round(rect.height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, rect.width, rect.height);
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#101820";
  }, []);

  const at = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <div className="capture">
      <p className="muted">Write your working. K9 will read it.</p>
      <canvas
        ref={canvas}
        className="pad"
        aria-label="Draw your working"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const context = event.currentTarget.getContext("2d");
          if (!context) return;
          drawing.current = true;
          setUsed(true);
          const { x, y } = at(event);
          context.beginPath();
          context.moveTo(x, y);
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const context = event.currentTarget.getContext("2d");
          if (!context) return;
          const { x, y } = at(event);
          context.lineTo(x, y);
          context.stroke();
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <div className="capture-actions">
        <button onClick={onCancel} className="ghost">
          Cancel
        </button>
        <button
          disabled={!used}
          onClick={async () => {
            const element = canvas.current;
            if (!element) return;
            onCapture(await toJpeg(element, element.width, element.height), "working");
          }}
        >
          Ask K9
        </button>
      </div>
    </div>
  );
}
