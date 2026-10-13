import { useCallback, useEffect, useMemo, useState } from "react";
import { useCamera } from "./camera";

// ---------------------------------------------------------------------------
// KobeAI Lens — onboarding.
//
// This is what a teacher sees after scanning the QR code the head of school
// printed. It is the whole of setting a school up, on the phone already in
// their pocket:
//
//   1. Who you are      — name, age band, subjects, classes, and the name you
//                         want K9 to call you. Submitting it creates the
//                         account; there is no login screen anywhere in this
//                         flow.
//   2. Your class list  — photograph the printed list from the office. The
//                         school's own vision model reads it; you check the
//                         rows and press Add. Nobody types 45 names.
//   3. The faces        — K9 shows one name at a time. Call that student
//                         over, tap the shutter, next. A period's work, and
//                         camera presence starts working.
//   4. Subject options  — photograph the signed subject sheet so K9 knows who
//                         takes Physics and who dropped it.
//
// Every read is a proposal you check before it is saved. Steps 2-4 can be
// skipped and picked up later from the same menu.
// ---------------------------------------------------------------------------

type Step = "loading" | "invalid" | "profile" | "menu" | "roster" | "faces" | "subjects" | "done";

type InviteForm = {
  school_name: string;
  label: string | null;
  role: string;
  options: {
    subjects: string[];
    classes: string[];
    age_bands: string[];
    teaching_styles: string[];
    briefing_lengths: string[];
    languages: string[];
  };
};

type RosterRow = { name: string; student_code?: string; sex?: string; confidence: number };
type SubjectRow = { name: string; subjects: string[]; confidence: number };

type PaperImport = {
  id: number;
  kind: string;
  status: string;
  parsed: RosterRow[] | SubjectRow[];
  model: string | null;
  error?: string | null;
};

type QueuedStudent = { id: number; name: string; student_code: string | null; photos: number };

const STYLE_LABELS: Record<string, string> = {
  examples: "Worked examples",
  drill: "Practice and drill",
  discussion: "Class discussion",
  visual: "Diagrams and visuals",
};

const LANGUAGE_LABELS: Record<string, string> = { sw: "Kiswahili", en: "English" };

const BRIEFING_LABELS: Record<string, string> = {
  short: "One line",
  normal: "A few lines",
  detailed: "Everything you have",
};

const apiBase = () => window.location.origin;

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(`${apiBase()}/api${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof Blob ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** The token in `#/onboard/<token>`. */
function tokenFromHash(): string {
  const m = /#\/onboard\/([^/?]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]!) : "";
}

export function Onboarding() {
  const [step, setStep] = useState<Step>("loading");
  const [invite, setInvite] = useState<InviteForm | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [teacherName, setTeacherName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const inviteToken = useMemo(tokenFromHash, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    (async () => {
      try {
        const form = await api<InviteForm>(`/v1/onboarding/invites/${inviteToken}/form`);
        setInvite(form);
        setStep("profile");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep("invalid");
      }
    })();
  }, [inviteToken]);

  const onClaimed = (accessToken: string, name: string) => {
    setToken(accessToken);
    setTeacherName(name);
    // Same key the Lens itself reads, so when onboarding finishes the
    // teacher is already signed in to the tool they will use every day.
    localStorage.setItem(
      "k9-lens.auth",
      JSON.stringify({ api_base: apiBase(), token: accessToken, teacher_name: name }),
    );
    setStep("menu");
  };

  if (step === "loading") {
    return <Centered>Checking the code…</Centered>;
  }

  if (step === "invalid") {
    return (
      <Centered>
        <h1>That code did not work</h1>
        <p className="onb-muted">{error}</p>
        <p className="onb-muted">Ask the head of school to print a fresh one.</p>
      </Centered>
    );
  }

  return (
    <div className="onb">
      {toast && <div className="lens-toast">{toast}</div>}

      {step === "profile" && invite && (
        <ProfileStep invite={invite} inviteToken={inviteToken} onClaimed={onClaimed} />
      )}

      {step === "menu" && (
        <Menu
          teacherName={teacherName}
          token={token!}
          onPick={setStep}
          onDone={() => setStep("done")}
        />
      )}

      {step === "roster" && (
        <PaperStep
          kind="roster"
          token={token!}
          onBack={() => setStep("menu")}
          notify={setToast}
        />
      )}

      {step === "subjects" && (
        <PaperStep
          kind="subjects"
          token={token!}
          onBack={() => setStep("menu")}
          notify={setToast}
        />
      )}

      {step === "faces" && (
        <FaceWalk token={token!} onBack={() => setStep("menu")} notify={setToast} />
      )}

      {step === "done" && (
        <Centered>
          <h1>All set, {teacherName.split(" ")[0]}</h1>
          <p className="onb-muted">
            K9 knows your class, their faces and their subjects. Open the Lens whenever you want
            a briefing on a student or want to mark a paper.
          </p>
          <button
            className="setup-btn"
            onClick={() => {
              window.location.hash = "";
              window.location.reload();
            }}
          >
            Open the Lens
          </button>
        </Centered>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — who you are
// ---------------------------------------------------------------------------

function ProfileStep({
  invite,
  inviteToken,
  onClaimed,
}: {
  invite: InviteForm;
  inviteToken: string;
  onClaimed: (token: string, name: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ageBand, setAgeBand] = useState("");
  const [language, setLanguage] = useState(invite.options.languages[0] ?? "sw");
  const [style, setStyle] = useState("examples");
  const [briefing, setBriefing] = useState("short");
  const [subjects, setSubjects] = useState<string[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [extraSubject, setExtraSubject] = useState("");
  const [extraClass, setExtraClass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedNickname = fullName.trim().split(/\s+/)[0] ?? "";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ access_token: string; teacher_name: string }>(
        `/v1/onboarding/invites/${inviteToken}/claim`,
        {
          method: "POST",
          body: JSON.stringify({
            full_name: fullName,
            nickname: nickname.trim() || suggestedNickname,
            email,
            password,
            age_band: ageBand,
            language,
            teaching_style: style,
            briefing_length: briefing,
            subjects,
            classes,
          }),
        },
      );
      onClaimed(res.access_token, res.teacher_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready =
    fullName.trim().length >= 4 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    password.length >= 8;

  return (
    <div className="onb-page">
      <h1>Welcome to {invite.school_name}</h1>
      <p className="onb-muted">
        A few taps and K9 is yours — it will speak to you the way you choose here.
      </p>

      <label>Your full name</label>
      <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Asha Juma Mwangi" />

      <label>What should K9 call you?</label>
      <input
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        placeholder={suggestedNickname ? `Mwalimu ${suggestedNickname}` : "Mwalimu"}
      />

      <label>Email (this is your sign-in)</label>
      <input
        type="email"
        autoCapitalize="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="asha@school.tz"
      />

      <label>Choose a password (8 characters or more)</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />

      <label>Your age</label>
      <Chips options={invite.options.age_bands} value={ageBand} onChange={setAgeBand} />

      <label>How do you like to teach?</label>
      <Chips
        options={invite.options.teaching_styles}
        value={style}
        onChange={setStyle}
        labels={STYLE_LABELS}
      />

      <label>Which language should K9 speak to you in?</label>
      <Chips
        options={invite.options.languages}
        value={language}
        onChange={setLanguage}
        labels={LANGUAGE_LABELS}
      />

      <label>How much should a briefing tell you?</label>
      <Chips
        options={invite.options.briefing_lengths}
        value={briefing}
        onChange={setBriefing}
        labels={BRIEFING_LABELS}
      />

      <label>Subjects you teach</label>
      <MultiChips options={invite.options.subjects} value={subjects} onChange={setSubjects} />
      <AddRow
        placeholder="Add a subject"
        value={extraSubject}
        onChange={setExtraSubject}
        onAdd={(v) => setSubjects([...new Set([...subjects, v])])}
      />

      <label>Classes you take</label>
      <MultiChips options={invite.options.classes} value={classes} onChange={setClasses} />
      <AddRow
        placeholder="Add a class, e.g. Form 2A"
        value={extraClass}
        onChange={setExtraClass}
        onAdd={(v) => setClasses([...new Set([...classes, v])])}
      />

      {error && <p className="onb-error">{error}</p>}

      <button className="setup-btn" disabled={!ready || busy} onClick={submit}>
        {busy ? "Creating your account…" : "Create my account"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The walk-through menu
// ---------------------------------------------------------------------------

function Menu({
  teacherName,
  token,
  onPick,
  onDone,
}: {
  teacherName: string;
  token: string;
  onPick: (step: Step) => void;
  onDone: () => void;
}) {
  const [progress, setProgress] = useState<{
    students: number;
    students_with_face: number;
    students_without_face: number;
  } | null>(null);

  useEffect(() => {
    api<{ progress: typeof progress }>("/v1/onboarding/me", {}, token)
      .then((r) => setProgress(r.progress))
      .catch(() => setProgress(null));
  }, [token]);

  return (
    <div className="onb-page">
      <h1>Karibu, {teacherName.split(" ")[0]}</h1>
      <p className="onb-muted">Three things and K9 knows your class as well as you do.</p>

      <TaskCard
        n={1}
        title="Photograph your class list"
        body="The printed list from the office. K9 reads the names off the photo — you just check them."
        done={(progress?.students ?? 0) > 0}
        detail={progress ? `${progress.students} students on the roll` : ""}
        onClick={() => onPick("roster")}
      />
      <TaskCard
        n={2}
        title="Take each student's photo"
        body="K9 shows one name at a time. Call that student over and tap the shutter."
        done={!!progress && progress.students > 0 && progress.students_without_face === 0}
        detail={
          progress
            ? `${progress.students_with_face} of ${progress.students} photographed`
            : ""
        }
        onClick={() => onPick("faces")}
      />
      <TaskCard
        n={3}
        title="Photograph the subject sheet"
        body="The signed sheet of who takes which subjects, so nobody is quizzed on a paper they dropped."
        done={false}
        detail=""
        onClick={() => onPick("subjects")}
      />

      <button className="setup-btn" onClick={onDone}>
        I am finished
      </button>
    </div>
  );
}

function TaskCard({
  n,
  title,
  body,
  done,
  detail,
  onClick,
}: {
  n: number;
  title: string;
  body: string;
  done: boolean;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button className={`onb-task${done ? " done" : ""}`} onClick={onClick}>
      <span className="onb-task-n">{done ? "✓" : n}</span>
      <span className="onb-task-text">
        <strong>{title}</strong>
        <span className="onb-muted">{body}</span>
        {detail && <span className="onb-detail">{detail}</span>}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Steps 2 and 4 — photograph a sheet, check the rows, commit
// ---------------------------------------------------------------------------

function PaperStep({
  kind,
  token,
  onBack,
  notify,
}: {
  kind: "roster" | "subjects";
  token: string;
  onBack: () => void;
  notify: (msg: string) => void;
}) {
  const { videoRef, ready, err, captureBlob } = useCamera();
  const [className, setClassName] = useState("");
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<PaperImport | null>(null);
  const [rows, setRows] = useState<Array<RosterRow | SubjectRow>>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [typing, setTyping] = useState(false);

  const isRoster = kind === "roster";

  const receive = useCallback((imp: PaperImport) => {
    setImported(imp);
    setRows(Array.isArray(imp.parsed) ? [...imp.parsed] : []);
  }, []);

  const shoot = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await captureBlob(2000);
      if (!blob) throw new Error("The camera did not give a picture — try again.");
      const query = new URLSearchParams({ kind });
      if (className.trim()) query.set("class_name", className.trim());
      const res = await fetch(`${apiBase()}/api/v1/onboarding/papers?${query}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", authorization: `Bearer ${token}` },
        body: blob,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Could not read that photo (${res.status})`);
      receive(body.import as PaperImport);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTyped = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ import: PaperImport }>(
        "/v1/onboarding/papers/text",
        {
          method: "POST",
          body: JSON.stringify({ kind, text: typed, class_name: className.trim() || undefined }),
        },
        token,
      );
      receive(body.import);
      setTyping(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!imported) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/onboarding/papers/${imported.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parsed: rows, class_name: className.trim() || undefined }),
      }, token);
      const res = await api<{ created: number; updated: number; unmatched?: string[] }>(
        `/v1/onboarding/papers/${imported.id}/commit`,
        { method: "POST", body: "{}" },
        token,
      );
      notify(
        isRoster
          ? `${res.created} students added, ${res.updated} already knew.`
          : `Subjects saved${res.unmatched?.length ? `, ${res.unmatched.length} names not recognised` : ""}.`,
      );
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (imported) {
    return (
      <div className="onb-page">
        <h1>{isRoster ? "Check the names" : "Check the subjects"}</h1>
        <p className="onb-muted">
          {rows.length} read by {imported.model ?? "the line reader"}. Fix anything wrong, delete
          anything that is not a student, then save.
        </p>
        {rows.map((row, i) => (
          <div key={i} className="onb-row">
            <input
              value={row.name}
              onChange={(e) => {
                const next = [...rows];
                next[i] = { ...row, name: e.target.value };
                setRows(next);
              }}
            />
            {!isRoster && (
              <span className="onb-muted onb-row-sub">
                {(row as SubjectRow).subjects.join(", ") || "no subjects read"}
              </span>
            )}
            {row.confidence < 70 && <span className="onb-flag">check</span>}
            <button className="onb-del" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        {error && <p className="onb-error">{error}</p>}
        <button className="setup-btn" disabled={busy || rows.length === 0} onClick={commit}>
          {busy ? "Saving…" : isRoster ? `Add these ${rows.length} students` : "Save these subjects"}
        </button>
        <button className="onb-ghost" onClick={() => setImported(null)}>
          Take the photo again
        </button>
      </div>
    );
  }

  if (typing) {
    return (
      <div className="onb-page">
        <h1>Type or paste the list</h1>
        <p className="onb-muted">One student per line. K9 reads it the same way it reads a photo.</p>
        <textarea
          className="onb-textarea"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={"1. ASHA JUMA MWANGI\n2. BARAKA PETER SHAYO"}
        />
        {error && <p className="onb-error">{error}</p>}
        <button className="setup-btn" disabled={busy || typed.trim().length < 8} onClick={sendTyped}>
          {busy ? "Reading…" : "Read this list"}
        </button>
        <button className="onb-ghost" onClick={() => setTyping(false)}>
          Use the camera instead
        </button>
      </div>
    );
  }

  return (
    <div className="onb-camera">
      <div className="onb-camera-head">
        <button className="onb-ghost" onClick={onBack}>
          ← Back
        </button>
        <span>{isRoster ? "Class list" : "Subject options"}</span>
      </div>
      <div className="lens-viewport">
        <video ref={videoRef} playsInline muted />
        <div className="lens-overlay">
          <div className="headline">
            {isRoster ? "Photograph the class list" : "Photograph the subject sheet"}
          </div>
          <div className="sub">
            {err
              ? err
              : ready
                ? "Fill the frame with the page, hold steady, then tap."
                : "Starting the camera…"}
          </div>
        </div>
      </div>
      <div className="onb-camera-foot">
        <input
          className="onb-inline-input"
          placeholder={isRoster ? "Which class? e.g. Form 2A" : "Which form? e.g. Form 3"}
          value={className}
          onChange={(e) => setClassName(e.target.value)}
        />
        {error && <p className="onb-error">{error}</p>}
        <button className="lens-shutter" disabled={!ready || busy} onClick={shoot}>
          {busy ? "…" : ""}
        </button>
        <button className="onb-ghost" onClick={() => setTyping(true)}>
          No camera? Type the list instead
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — the face walk
// ---------------------------------------------------------------------------

function FaceWalk({
  token,
  onBack,
  notify,
}: {
  token: string;
  onBack: () => void;
  notify: (msg: string) => void;
}) {
  const { videoRef, ready, err, captureBlob } = useCamera();
  const [queue, setQueue] = useState<QueuedStudent[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ students: QueuedStudent[] }>("/v1/onboarding/face-queue", {}, token)
      .then((r) => setQueue(r.students.filter((s) => s.photos === 0 && s.student_code)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [token]);

  const student = queue[index];

  const shoot = async () => {
    if (!student?.student_code) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await captureBlob(1200);
      if (!blob) throw new Error("The camera did not give a picture — try again.");
      const res = await fetch(
        `${apiBase()}/api/v1/faces/students/${encodeURIComponent(student.student_code)}`,
        {
          method: "POST",
          headers: { "content-type": "image/jpeg", authorization: `Bearer ${token}` },
          body: blob,
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "K9 could not find a face in that photo.");
      notify(`${student.name} saved`);
      setIndex((i) => i + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Centered>Loading your class…</Centered>;

  if (!student) {
    return (
      <Centered>
        <h1>{queue.length === 0 ? "Nobody to photograph" : "Every student photographed"}</h1>
        <p className="onb-muted">
          {queue.length === 0
            ? "Add your class list first, then come back here."
            : `${queue.length} students are now in K9's face gallery.`}
        </p>
        <button className="setup-btn" onClick={onBack}>
          Back
        </button>
      </Centered>
    );
  }

  return (
    <div className="onb-camera">
      <div className="onb-camera-head">
        <button className="onb-ghost" onClick={onBack}>
          ← Back
        </button>
        <span>
          {index + 1} of {queue.length}
        </span>
      </div>
      <div className="lens-viewport">
        <video ref={videoRef} playsInline muted />
        <div className="lens-overlay">
          <div className="headline">{student.name}</div>
          <div className="sub">
            {err
              ? err
              : ready
                ? "Call them over, fill the frame with their face, then tap."
                : "Starting the camera…"}
          </div>
        </div>
      </div>
      <div className="onb-camera-foot">
        {error && <p className="onb-error">{error}</p>}
        <button className="lens-shutter" disabled={!ready || busy} onClick={shoot}>
          {busy ? "…" : ""}
        </button>
        <button className="onb-ghost" onClick={() => setIndex((i) => i + 1)}>
          {student.name.split(" ")[0]} is absent — skip
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Chips({
  options,
  value,
  onChange,
  labels,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div className="onb-chips">
      {options.map((opt) => (
        <button
          key={opt}
          className={`onb-chip${value === opt ? " on" : ""}`}
          onClick={() => onChange(opt)}
        >
          {labels?.[opt] ?? opt}
        </button>
      ))}
    </div>
  );
}

function MultiChips({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const all = [...new Set([...options, ...value])];
  if (all.length === 0) return <p className="onb-muted">Add the first one below.</p>;
  return (
    <div className="onb-chips">
      {all.map((opt) => (
        <button
          key={opt}
          className={`onb-chip${value.includes(opt) ? " on" : ""}`}
          onClick={() =>
            onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt])
          }
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function AddRow({
  placeholder,
  value,
  onChange,
  onAdd,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onAdd: (v: string) => void;
}) {
  const add = () => {
    const v = value.trim();
    if (!v) return;
    onAdd(v);
    onChange("");
  };
  return (
    <div className="onb-add">
      <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <button className="onb-chip" onClick={add}>
        Add
      </button>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="onb onb-centered">
      <div className="onb-page">{children}</div>
    </div>
  );
}
