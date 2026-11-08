import { useEffect, useState } from "react";
import type { TeacherAuth } from "./TeacherWorkspace";

// ---------------------------------------------------------------------------
// The durable upload queue.
//
// A captured frame used to be posted straight to the school server and thrown
// away if that failed. During marking the lens photographs the paper every few
// seconds, so a school Wi-Fi dropout quietly removed pages from an exam.
//
// Now a frame is written to the phone first and only then uploaded. It stays
// on the phone until the server has accepted it, across outages and across the
// app being closed. Nothing here deletes an unsent frame on its own: when the
// queue is full, capture stops and says so; a frame the server refuses stays
// listed as failed until the teacher retries or removes it.
//
// Each frame carries the id it was given when it was taken. Every upload
// attempt sends that id, and the server answers a repeat with the first
// attempt's result (api-server lib/lens-capture.ts), so retrying is safe.
//
// Frames belong to the account that captured them — this school server, this
// teacher — and are only ever uploaded with that account's own sign-in.
// ---------------------------------------------------------------------------

export type FrameMode = "lookup" | "mark";
export type FrameState = "pending" | "uploading" | "failed" | "done";

export type QueuedFrame = {
  /** Capture id: also the idempotency key sent to the server. */
  id: string;
  owner: string;
  mode: FrameMode;
  examId: number | null;
  createdAt: number;
  bytes: number;
  state: FrameState;
  attempts: number;
  lastError: string | null;
  /** A lookup that was not sent in time. It can be removed, not retried. */
  expired?: boolean;
  requestId: number | null;
  imageKey: string | null;
  uploadedAt: number | null;
};

export type QueueStatus = {
  /** Uploads are stopped until the teacher signs in again. */
  needsSignIn: boolean;
  /** Epoch ms of the next automatic attempt while the server is unreachable. */
  retryAt: number | null;
};

/** Unsent frames one account may hold on this phone. ~10 minutes of marking. */
export const MAX_WAITING_FRAMES = 240;
export const MAX_WAITING_BYTES = 160 * 1024 * 1024;
/** Uploaded frames kept in the list (their images are already deleted). */
const KEEP_DONE = 40;
/** A lookup answers "who is this, now"; sent minutes late it is only noise. */
const LOOKUP_TTL_MS = 2 * 60_000;
const LOOKUP_EXPIRED = "This lookup was not sent in time, so it was held back and will not be sent. Take a new one if you still need it.";
const UPLOAD_TIMEOUT_MS = 30_000;
const FIRST_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

export class QueueFullError extends Error {}
export class QueueStorageError extends Error {}

// --- account identity ------------------------------------------------------

function tokenSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
    b = Math.imul(b + text.charCodeAt(i), 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/**
 * Who a frame belongs to: the school server plus the teacher's user id from
 * their sign-in token. A token that does not name a user is treated as its own
 * account, so its frames wait for that exact sign-in rather than being handed
 * to whoever signs in next.
 */
export function ownerKey(auth: TeacherAuth): string {
  const subject = tokenSubject(auth.token);
  return `${auth.api_base}|${subject ? `user:${subject}` : `token:${fingerprint(auth.token)}`}`;
}

// --- storage ---------------------------------------------------------------
// Two stores so listing the queue never loads the images into memory.

const DB_NAME = "k9-lens-uploads";
const META = "frames";
const DATA = "images";

let dbPromise: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new QueueStorageError("This browser cannot store captures on the device."));
        return;
      }
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const meta = open.result.createObjectStore(META, { keyPath: "id" });
        meta.createIndex("owner", "owner");
        open.result.createObjectStore(DATA);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new QueueStorageError("Could not open capture storage on this device."));
      open.onblocked = () => reject(new QueueStorageError("Capture storage is busy. Close other KobeAI tabs and try again."));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function framesOf(owner: string): Promise<QueuedFrame[]> {
  const db = await database();
  const frames = await request(db.transaction(META).objectStore(META).index("owner").getAll(owner) as IDBRequest<QueuedFrame[]>);
  return frames.sort((x, y) => x.createdAt - y.createdAt);
}

async function patch(id: string, change: Partial<QueuedFrame>, dropImage = false): Promise<QueuedFrame | null> {
  const db = await database();
  const tx = db.transaction([META, DATA], "readwrite");
  const store = tx.objectStore(META);
  const current = await request(store.get(id) as IDBRequest<QueuedFrame | undefined>);
  if (!current) return null;
  const next = { ...current, ...change };
  store.put(next);
  if (dropImage) tx.objectStore(DATA).delete(id);
  await finished(tx);
  return next;
}

function newCaptureId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const waiting = (frame: QueuedFrame) => frame.state !== "done";

function fullMessage(frames: number): string {
  return `Capture storage on this phone is full: ${frames} photos are waiting to upload. Capturing is paused so none are lost. Reconnect to the school server, or review them under Activity.`;
}

/** Throws QueueFullError when this account has no room for another frame. */
export async function assertRoom(owner: string, incomingBytes = 0): Promise<void> {
  const held = (await framesOf(owner)).filter(waiting);
  const bytes = held.reduce((sum, frame) => sum + frame.bytes, 0);
  if (held.length >= MAX_WAITING_FRAMES || bytes + incomingBytes > MAX_WAITING_BYTES) throw new QueueFullError(fullMessage(held.length));
}

/** Write a captured frame to the phone. Resolves only once it is safely stored. */
export async function enqueueFrame(
  owner: string,
  capture: { blob: Blob; mode: FrameMode; examId: number | null },
): Promise<QueuedFrame> {
  const data = await capture.blob.arrayBuffer();
  await assertRoom(owner, data.byteLength);
  const frame: QueuedFrame = {
    id: newCaptureId(),
    owner,
    mode: capture.mode,
    examId: capture.examId,
    createdAt: Date.now(),
    bytes: data.byteLength,
    state: "pending",
    attempts: 0,
    lastError: null,
    requestId: null,
    imageKey: null,
    uploadedAt: null,
  };
  const db = await database();
  try {
    const tx = db.transaction([META, DATA], "readwrite");
    tx.objectStore(DATA).put(data, frame.id);
    tx.objectStore(META).put(frame);
    await finished(tx);
  } catch (error) {
    if ((error as DOMException | null)?.name === "QuotaExceededError")
      throw new QueueFullError("This phone is out of storage space, so the photo could not be saved. Free some space, then capture again.");
    throw new QueueStorageError("The photo could not be saved on this phone, so it was not captured. Try again.");
  }
  changed();
  kick();
  return frame;
}

/** Remove one frame for good. Only ever called from an explicit teacher action. */
export async function discardFrame(id: string): Promise<void> {
  const db = await database();
  const tx = db.transaction([META, DATA], "readwrite");
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await finished(tx);
  changed();
}

/** Put failed frames back in line. With no id, every failed frame of the account. */
export async function retryFrames(owner: string, id?: string): Promise<void> {
  for (const frame of await framesOf(owner)) {
    // An expired lookup stays failed: sent now it would whisper about a student
    // the teacher looked at minutes ago. A frame's capture time is never edited.
    if (frame.state !== "failed" || frame.expired || (id && frame.id !== id)) continue;
    await patch(frame.id, { state: "pending", lastError: null });
  }
  pausedUntil = 0;
  backoff = FIRST_BACKOFF_MS;
  changed();
  kick();
}

// --- change notification ---------------------------------------------------

const listeners = new Set<() => void>();
function changed(): void {
  listeners.forEach((listener) => listener());
}

// --- the uploader ----------------------------------------------------------

type Account = { auth: TeacherAuth; owner: string; sessionId: () => number | null };
let account: Account | null = null;
let pumping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let backoff = FIRST_BACKOFF_MS;
let pausedUntil = 0;
let needsSignIn = false;

export function queueStatus(): QueueStatus {
  return { needsSignIn, retryAt: pausedUntil > Date.now() ? pausedUntil : null };
}

type Outcome =
  | { kind: "done"; requestId: number | null; imageKey: string | null }
  | { kind: "retry"; reason: string }
  | { kind: "sign-in" }
  | { kind: "expired" }
  | { kind: "rejected"; reason: string };

async function send(to: Account, frame: QueuedFrame, data: ArrayBuffer): Promise<Outcome> {
  let response: Response;
  try {
    const sessionId = to.sessionId();
    response = await fetch(`${to.auth.api_base}/api/v1/teacher-lens/frame`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${to.auth.token}`,
        "content-type": "image/jpeg",
        "x-lens-capture-id": frame.id,
        // An age, not a timestamp: both ends come from this phone's clock, so
        // a phone with the wrong time still reports when the photo was taken.
        "x-lens-capture-age-ms": String(Math.max(0, Date.now() - frame.createdAt)),
        "x-lens-session-id": String(sessionId ?? ""),
        "x-lens-mode": frame.mode,
        ...(frame.examId ? { "x-lens-exam-id": String(frame.examId) } : {}),
      },
      body: data,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    return { kind: "retry", reason: "School server unreachable. Retrying automatically." };
  }
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { request?: { id?: number }; image_key?: string } | null;
    return { kind: "done", requestId: body?.request?.id ?? null, imageKey: body?.image_key ?? null };
  }
  if (response.status === 401 || response.status === 403) return { kind: "sign-in" };
  if (response.status === 410) return { kind: "expired" };
  // 409 is the server still working on an earlier attempt of this same capture.
  if (response.status >= 500 || [408, 409, 425, 429].includes(response.status))
    return { kind: "retry", reason: `School server busy (HTTP ${response.status}). Retrying automatically.` };
  return { kind: "rejected", reason: `The school server refused this photo (HTTP ${response.status}).` };
}

async function pruneDone(owner: string): Promise<void> {
  const done = (await framesOf(owner)).filter((frame) => frame.state === "done");
  for (const frame of done.slice(0, Math.max(0, done.length - KEEP_DONE))) await discardFrame(frame.id);
}

async function pump(): Promise<void> {
  if (pumping || !account) return;
  pumping = true;
  const mine = account;
  try {
    // The identity check is repeated before every frame: a sign-out or account
    // switch stops this loop before it can send another account's evidence.
    while (account === mine && !needsSignIn) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) {
        clearTimeout(timer);
        timer = setTimeout(kick, wait);
        break;
      }
      const frame = (await framesOf(mine.owner)).find((candidate) => candidate.state === "pending");
      if (!frame) break;
      // The server routes whispers by session, so a frame sent before the
      // session exists would be answered into the void. Starting one is the
      // first thing the lens does once the server is reachable.
      if (mine.sessionId() == null) {
        clearTimeout(timer);
        timer = setTimeout(kick, 1000);
        break;
      }
      if (frame.mode === "lookup" && Date.now() - frame.createdAt > LOOKUP_TTL_MS) {
        await patch(frame.id, { state: "failed", expired: true, lastError: LOOKUP_EXPIRED });
        changed();
        continue;
      }
      const db = await database();
      const data = await request(db.transaction(DATA).objectStore(DATA).get(frame.id) as IDBRequest<ArrayBuffer | undefined>);
      if (!data) {
        await patch(frame.id, { state: "failed", lastError: "The photo is missing from this phone's storage and cannot be sent." });
        changed();
        continue;
      }
      await patch(frame.id, { state: "uploading", attempts: frame.attempts + 1 });
      changed();
      const outcome = await send(mine, frame, data);
      if (outcome.kind === "done") {
        await patch(frame.id, { state: "done", lastError: null, requestId: outcome.requestId, imageKey: outcome.imageKey, uploadedAt: Date.now() }, true);
        backoff = FIRST_BACKOFF_MS;
        await pruneDone(mine.owner);
      } else if (outcome.kind === "expired") {
        await patch(frame.id, { state: "failed", expired: true, lastError: LOOKUP_EXPIRED });
      } else if (outcome.kind === "rejected") {
        await patch(frame.id, { state: "failed", lastError: outcome.reason });
      } else {
        await patch(frame.id, { state: "pending", lastError: outcome.kind === "retry" ? outcome.reason : "Sign in again to upload this photo." });
        if (outcome.kind === "sign-in") needsSignIn = true;
        else {
          pausedUntil = Date.now() + backoff;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
      changed();
    }
  } catch {
    // Storage hiccup: nothing was deleted; the next kick starts over.
  } finally {
    pumping = false;
    if (account && account !== mine) kick();
  }
}

function kick(): void {
  void pump();
}

/** Try again now rather than waiting out the backoff. */
export function retryNow(): void {
  pausedUntil = 0;
  backoff = FIRST_BACKOFF_MS;
  changed();
  kick();
}

/**
 * Begin uploading this account's stored frames. Returns the function that
 * stops it (sign-out). Frames left "uploading" by a closed app or an earlier
 * sign-in are put back in line: whether or not that attempt reached the
 * server, the capture id makes sending it again safe.
 */
export function startUploads(auth: TeacherAuth, sessionId: () => number | null): () => void {
  const mine: Account = { auth, owner: ownerKey(auth), sessionId };
  account = mine;
  needsSignIn = false;
  pausedUntil = 0;
  backoff = FIRST_BACKOFF_MS;
  void (async () => {
    try {
      for (const frame of await framesOf(mine.owner)) if (frame.state === "uploading") await patch(frame.id, { state: "pending" });
    } catch {
      /* reported when the teacher next captures */
    }
    changed();
    kick();
  })();
  const resume = () => {
    if (document.visibilityState !== "hidden") retryNow();
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  return () => {
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", resume);
    if (account === mine) {
      account = null;
      clearTimeout(timer);
      changed();
    }
  };
}

/** Resolves when the frame is uploaded or failed, or with its current state after `ms`. */
export function settled(id: string, owner: string, ms: number): Promise<QueuedFrame | null> {
  return new Promise((resolve) => {
    let over = false;
    const finish = async (force: boolean) => {
      if (over) return;
      const frame = (await framesOf(owner).catch(() => [])).find((candidate) => candidate.id === id) ?? null;
      if (over || (!force && frame && (frame.state === "pending" || frame.state === "uploading"))) return;
      over = true;
      listeners.delete(listener);
      clearTimeout(deadline);
      resolve(frame);
    };
    const listener = () => void finish(false);
    const deadline = setTimeout(() => void finish(true), ms);
    listeners.add(listener);
    listener();
  });
}

/** The signed-in account's frames, newest first, kept current. */
export function useUploadQueue(auth: TeacherAuth | null): {
  frames: QueuedFrame[];
  status: QueueStatus;
  /** Unsent frames on this phone that belong to other accounts. */
  otherAccounts: number;
} {
  const [state, setState] = useState<{ frames: QueuedFrame[]; status: QueueStatus; otherAccounts: number }>({
    frames: [],
    status: { needsSignIn: false, retryAt: null },
    otherAccounts: 0,
  });
  useEffect(() => {
    if (!auth) {
      setState({ frames: [], status: { needsSignIn: false, retryAt: null }, otherAccounts: 0 });
      return;
    }
    const owner = ownerKey(auth);
    let stopped = false;
    const refresh = async () => {
      try {
        const db = await database();
        const all = await request(db.transaction(META).objectStore(META).getAll() as IDBRequest<QueuedFrame[]>);
        if (stopped) return;
        setState({
          frames: all.filter((frame) => frame.owner === owner).sort((x, y) => y.createdAt - x.createdAt),
          status: queueStatus(),
          otherAccounts: all.filter((frame) => frame.owner !== owner && waiting(frame)).length,
        });
      } catch {
        /* storage unavailable: capture reports it */
      }
    };
    const listener = () => void refresh();
    listeners.add(listener);
    void refresh();
    return () => {
      stopped = true;
      listeners.delete(listener);
    };
  }, [auth]);
  return state;
}
