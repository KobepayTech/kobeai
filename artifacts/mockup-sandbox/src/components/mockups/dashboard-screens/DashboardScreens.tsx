import type { ReactNode } from "react";

const PRIMARY = "#00A86B";
const PRIMARY_SOFT = "#E6F6EE";
const INK = "#1A1A2E";

// ============================================================================
// Dashboard chrome (sidebar + topbar) shared by both pages.
// Mirrors the production layout in artifacts/teacher-dashboard.
// ============================================================================

function Chrome({
  page,
  children,
}: {
  page: "Timetable" | "Exams";
  children: ReactNode;
}) {
  const navItems = [
    { label: "Overview", icon: "📊" },
    { label: "Classes", icon: "👥" },
    { label: "Documents", icon: "📄" },
    { label: "Quizzes", icon: "❓" },
    { label: "Timetable", icon: "🗓️" },
    { label: "Exams", icon: "⏱️" },
    { label: "School AI", icon: "🤖" },
  ];

  return (
    <div className="flex" style={{ background: "#F6F8FB", minHeight: "100%" }}>
      {/* Sidebar */}
      <aside
        className="w-56 shrink-0 flex flex-col"
        style={{ background: INK, color: "white" }}
      >
        <div className="px-4 py-4 flex items-center gap-2 border-b border-white/10">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-black"
            style={{ background: PRIMARY }}
          >
            K
          </div>
          <div>
            <div className="text-sm font-bold leading-tight">KobeAI</div>
            <div className="text-[10px] text-gray-400 leading-tight">Teacher</div>
          </div>
        </div>
        <nav className="flex-1 py-3">
          {navItems.map((it) => {
            const active = it.label === page;
            return (
              <div
                key={it.label}
                className="px-3 py-2 mx-2 my-0.5 rounded-lg flex items-center gap-2 text-[13px]"
                style={{
                  background: active ? PRIMARY : "transparent",
                  color: active ? "white" : "#cbd5e1",
                  fontWeight: active ? 600 : 400,
                }}
              >
                <span>{it.icon}</span>
                <span>{it.label}</span>
              </div>
            );
          })}
        </nav>
        <div className="px-4 py-3 border-t border-white/10 text-[11px] text-gray-400">
          <div>Ms. Sarah Kamau</div>
          <div className="text-gray-500">teacher@school.tz</div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0">
        <header
          className="h-14 px-6 flex items-center justify-between border-b"
          style={{ background: "white", borderColor: "#e5e7eb" }}
        >
          <div className="text-[15px] font-semibold" style={{ color: INK }}>
            {page === "Timetable" ? "Class Timetable" : "Exam Mode"}
          </div>
          <div className="flex items-center gap-3 text-[12px] text-gray-500">
            <span>🔔</span>
            <span>Form 2A · 32 students</span>
          </div>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}

// ============================================================================
// Timetable page mockup
// ============================================================================

const HOURS = ["07:30", "08:00", "08:40", "09:20", "10:00", "10:40", "11:20", "12:00"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

type Cell = { subject: string; room: string; tone: "math" | "lang" | "sci" | "hist" | "pe" | "lunch" };
const PALETTE: Record<Cell["tone"], { bg: string; fg: string; border: string }> = {
  math: { bg: "#E6F6EE", fg: "#066A45", border: "#A7E5C7" },
  lang: { bg: "#FFF3DB", fg: "#7A4F00", border: "#F2D08A" },
  sci: { bg: "#E2EAFF", fg: "#1F3A8A", border: "#9EB7FF" },
  hist: { bg: "#FCE7F3", fg: "#9D174D", border: "#F7B7D7" },
  pe: { bg: "#E8F8F2", fg: "#0F766E", border: "#A7E0C9" },
  lunch: { bg: "#F1F5F9", fg: "#475569", border: "#CBD5E1" },
};

const SCHEDULE: Record<string, Cell | null> = {
  // Mon
  "Mon|07:30": { subject: "Assembly", room: "Hall", tone: "lunch" },
  "Mon|08:00": { subject: "Mathematics", room: "Room 12", tone: "math" },
  "Mon|08:40": { subject: "Mathematics", room: "Room 12", tone: "math" },
  "Mon|09:20": { subject: "Kiswahili", room: "Room 12", tone: "lang" },
  "Mon|10:00": { subject: "Break", room: "—", tone: "lunch" },
  "Mon|10:40": { subject: "Biology", room: "Lab 1", tone: "sci" },
  "Mon|11:20": { subject: "History", room: "Room 8", tone: "hist" },
  "Mon|12:00": { subject: "Lunch", room: "—", tone: "lunch" },
  // Tue
  "Tue|07:30": { subject: "Assembly", room: "Hall", tone: "lunch" },
  "Tue|08:00": { subject: "English", room: "Room 12", tone: "lang" },
  "Tue|08:40": { subject: "Mathematics", room: "Room 12", tone: "math" },
  "Tue|09:20": { subject: "Physics", room: "Lab 2", tone: "sci" },
  "Tue|10:00": { subject: "Break", room: "—", tone: "lunch" },
  "Tue|10:40": { subject: "Geography", room: "Room 8", tone: "hist" },
  "Tue|11:20": { subject: "PE", room: "Field", tone: "pe" },
  "Tue|12:00": { subject: "Lunch", room: "—", tone: "lunch" },
  // Wed
  "Wed|07:30": { subject: "Assembly", room: "Hall", tone: "lunch" },
  "Wed|08:00": { subject: "Mathematics", room: "Room 12", tone: "math" },
  "Wed|08:40": { subject: "Chemistry", room: "Lab 1", tone: "sci" },
  "Wed|09:20": { subject: "Kiswahili", room: "Room 12", tone: "lang" },
  "Wed|10:00": { subject: "Break", room: "—", tone: "lunch" },
  "Wed|10:40": { subject: "English", room: "Room 12", tone: "lang" },
  "Wed|11:20": { subject: "History", room: "Room 8", tone: "hist" },
  "Wed|12:00": { subject: "Lunch", room: "—", tone: "lunch" },
  // Thu
  "Thu|07:30": { subject: "Assembly", room: "Hall", tone: "lunch" },
  "Thu|08:00": { subject: "Biology", room: "Lab 1", tone: "sci" },
  "Thu|08:40": { subject: "Mathematics", room: "Room 12", tone: "math" },
  "Thu|09:20": { subject: "English", room: "Room 12", tone: "lang" },
  "Thu|10:00": { subject: "Break", room: "—", tone: "lunch" },
  "Thu|10:40": { subject: "Civics", room: "Room 8", tone: "hist" },
  "Thu|11:20": { subject: "PE", room: "Field", tone: "pe" },
  "Thu|12:00": { subject: "Lunch", room: "—", tone: "lunch" },
  // Fri
  "Fri|07:30": { subject: "Assembly", room: "Hall", tone: "lunch" },
  "Fri|08:00": { subject: "Mathematics", room: "Room 12", tone: "math" },
  "Fri|08:40": { subject: "Kiswahili", room: "Room 12", tone: "lang" },
  "Fri|09:20": { subject: "Physics", room: "Lab 2", tone: "sci" },
  "Fri|10:00": { subject: "Break", room: "—", tone: "lunch" },
  "Fri|10:40": { subject: "Geography", room: "Room 8", tone: "hist" },
  "Fri|11:20": { subject: "Free Study", room: "Library", tone: "lunch" },
  "Fri|12:00": { subject: "Lunch", room: "—", tone: "lunch" },
};

function TimetablePage() {
  // Highlight Fri 08:00 as the current period (matches "NOW" idea on the watch)
  const nowKey = "Fri|08:00";
  return (
    <Chrome page="Timetable">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold" style={{ color: INK }}>
            Weekly schedule
          </h2>
          <p className="text-[13px] text-gray-500">
            Drag-free editor · changes propagate to the watch <span style={{ color: PRIMARY, fontWeight: 600 }}>instantly</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="rounded-md px-3 py-1.5 text-[12px] flex items-center gap-2"
            style={{ background: "white", border: "1px solid #e5e7eb" }}
          >
            <span className="text-gray-500">Class:</span>
            <span className="font-semibold" style={{ color: INK }}>
              Form 2A
            </span>
            <span className="text-gray-400">▾</span>
          </div>
          <div
            className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-white flex items-center gap-1.5"
            style={{ background: PRIMARY }}
          >
            <span>＋</span> Add period
          </div>
        </div>
      </div>

      {/* Grid */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: "white", border: "1px solid #e5e7eb" }}
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `90px repeat(${DAYS.length}, 1fr)`,
            background: "#F8FAFC",
          }}
        >
          <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
            Time
          </div>
          {DAYS.map((d) => (
            <div
              key={d}
              className="px-3 py-2 text-[12px] font-bold text-center"
              style={{ color: INK, borderLeft: "1px solid #e5e7eb" }}
            >
              {d}
            </div>
          ))}
        </div>
        {HOURS.map((h, hi) => (
          <div
            key={h}
            className="grid"
            style={{
              gridTemplateColumns: `90px repeat(${DAYS.length}, 1fr)`,
              borderTop: "1px solid #e5e7eb",
            }}
          >
            <div
              className="px-3 py-3 text-[11px] font-mono text-gray-500 flex items-start"
              style={{ background: "#F8FAFC" }}
            >
              {h}
            </div>
            {DAYS.map((d) => {
              const key = `${d}|${h}`;
              const cell = SCHEDULE[key] ?? null;
              const isNow = key === nowKey;
              if (!cell) {
                return (
                  <div
                    key={key}
                    className="p-2 text-[10px] text-gray-300"
                    style={{ borderLeft: "1px solid #e5e7eb", minHeight: 56 }}
                  >
                    +
                  </div>
                );
              }
              const pal = PALETTE[cell.tone];
              return (
                <div
                  key={key}
                  className="p-2"
                  style={{ borderLeft: "1px solid #e5e7eb", minHeight: 56 }}
                >
                  <div
                    className="rounded-md px-2 py-1.5 h-full relative"
                    style={{
                      background: pal.bg,
                      border: `1px solid ${isNow ? PRIMARY : pal.border}`,
                      boxShadow: isNow ? `0 0 0 2px ${PRIMARY}33` : undefined,
                    }}
                  >
                    {isNow && (
                      <div
                        className="absolute -top-1.5 right-1 text-[8px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: PRIMARY, color: "white" }}
                      >
                        NOW
                      </div>
                    )}
                    <div
                      className="text-[11px] font-semibold leading-tight"
                      style={{ color: pal.fg }}
                    >
                      {cell.subject}
                    </div>
                    <div className="text-[9px] mt-0.5" style={{ color: pal.fg, opacity: 0.7 }}>
                      {cell.room}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-3 text-[11px] text-gray-600">
        {Object.entries(PALETTE).map(([k, p]) => (
          <div key={k} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded" style={{ background: p.bg, border: `1px solid ${p.border}` }} />
            <span style={{ textTransform: "capitalize" }}>{k}</span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-3 h-3 rounded" style={{ background: "white", border: `2px solid ${PRIMARY}` }} />
          <span style={{ color: PRIMARY, fontWeight: 600 }}>Currently teaching</span>
        </div>
      </div>
    </Chrome>
  );
}

// ============================================================================
// Exam Mode page mockup
// ============================================================================

function StatusBadge({ status }: { status: "active" | "scheduled" | "paused" | "finished" }) {
  const map = {
    active: { bg: PRIMARY, fg: "white", label: "● LIVE" },
    scheduled: { bg: "#FFF3DB", fg: "#7A4F00", label: "Scheduled" },
    paused: { bg: "#FEF3C7", fg: "#92400E", label: "⏸ Paused" },
    finished: { bg: "#F1F5F9", fg: "#475569", label: "Finished" },
  } as const;
  const s = map[status];
  return (
    <span
      className="text-[10px] font-bold px-2 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

function ControlButton({
  icon,
  label,
  variant = "ghost",
}: {
  icon: string;
  label: string;
  variant?: "primary" | "ghost" | "danger";
}) {
  const styles =
    variant === "primary"
      ? { background: PRIMARY, color: "white", border: "1px solid transparent" }
      : variant === "danger"
        ? { background: "white", color: "#B91C1C", border: "1px solid #FCA5A5" }
        : { background: "white", color: INK, border: "1px solid #e5e7eb" };
  return (
    <div
      className="rounded-md px-3 py-1.5 text-[12px] font-semibold flex items-center gap-1.5"
      style={styles}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

function ExamsPage() {
  return (
    <Chrome page="Exams">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold" style={{ color: INK }}>
            Exam supervisor
          </h2>
          <p className="text-[13px] text-gray-500">
            Starting an exam <span style={{ color: PRIMARY, fontWeight: 600 }}>locks all watches</span> in the class onto a fullscreen countdown.
          </p>
        </div>
        <div
          className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-white flex items-center gap-1.5"
          style={{ background: PRIMARY }}
        >
          <span>＋</span> New exam
        </div>
      </div>

      {/* Live exam — hero card */}
      <div
        className="rounded-2xl p-5 mb-4 relative overflow-hidden"
        style={{
          background: `linear-gradient(135deg, ${INK} 0%, #2a2a44 100%)`,
          color: "white",
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-gray-400 mb-1">
              Now supervising · Form 2A
            </div>
            <div className="text-[20px] font-bold leading-tight">Mid-term Mathematics</div>
            <div className="flex items-center gap-2 mt-1.5">
              <StatusBadge status="active" />
              <span className="text-[11px] text-gray-300">started 25:28 ago · +5 min added</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase text-gray-400 tracking-wider">
              Time remaining
            </div>
            <div
              className="text-[64px] font-bold leading-none font-mono tabular-nums"
              style={{ color: PRIMARY }}
            >
              4:32
            </div>
            <div className="text-[10px] text-gray-400 mt-1">of 60:00 total</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-4 h-1.5 rounded-full overflow-hidden" style={{ background: "#ffffff20" }}>
          <div className="h-full" style={{ width: "92%", background: PRIMARY }} />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 mt-4">
          <ControlButton icon="⏸" label="Pause" />
          <ControlButton icon="−1m" label="" />
          <ControlButton icon="+1m" label="" variant="primary" />
          <ControlButton icon="+5m" label="" variant="primary" />
          <div className="flex-1" />
          <ControlButton icon="■" label="Finish exam" variant="danger" />
        </div>

        {/* Watch sync indicators */}
        <div className="flex items-center gap-4 mt-4 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span style={{ color: PRIMARY }}>●</span> 32 / 32 watches synced
          </div>
          <div className="flex items-center gap-1.5">
            <span>📡</span> Last poll: 3 s ago
          </div>
          <div className="flex items-center gap-1.5">
            <span>🔇</span> Audio + AI disabled on watches
          </div>
        </div>
      </div>

      {/* Other exams list */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: "white", border: "1px solid #e5e7eb" }}
      >
        <div className="px-4 py-3 border-b" style={{ borderColor: "#e5e7eb" }}>
          <div className="text-[13px] font-bold" style={{ color: INK }}>
            Recent & upcoming
          </div>
        </div>
        {[
          { title: "Kiswahili Insha", cls: "Form 2A", when: "Today 13:30", dur: "45 min", status: "scheduled" as const },
          { title: "Biology Quick Test", cls: "Form 2A", when: "Yesterday 09:00", dur: "30 min", status: "finished" as const, taken: 31 },
          { title: "History Essay", cls: "Form 2A", when: "Mon 10:40", dur: "60 min", status: "finished" as const, taken: 32 },
        ].map((e) => (
          <div
            key={e.title}
            className="px-4 py-3 flex items-center gap-3 border-t"
            style={{ borderColor: "#f1f5f9" }}
          >
            <div
              className="w-8 h-8 rounded-md flex items-center justify-center"
              style={{ background: PRIMARY_SOFT, color: PRIMARY }}
            >
              ⏱
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: INK }}>
                {e.title}
              </div>
              <div className="text-[11px] text-gray-500">
                {e.cls} · {e.when} · {e.dur}
                {e.taken !== undefined && ` · ${e.taken} students`}
              </div>
            </div>
            <StatusBadge status={e.status} />
            {e.status === "scheduled" ? (
              <ControlButton icon="▶" label="Start" variant="primary" />
            ) : (
              <ControlButton icon="📊" label="Results" />
            )}
          </div>
        ))}
      </div>
    </Chrome>
  );
}

// ============================================================================
// Frame & export
// ============================================================================

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="rounded-xl overflow-hidden shadow-2xl"
        style={{
          width: 1180,
          height: 760,
          background: "white",
          border: "1px solid #e5e7eb",
        }}
      >
        {/* Browser chrome */}
        <div
          className="h-7 flex items-center gap-1.5 px-3"
          style={{ background: "#F1F5F9", borderBottom: "1px solid #e5e7eb" }}
        >
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FF5F57" }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#FEBC2E" }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#28C840" }} />
          <div
            className="ml-3 rounded px-2 py-0.5 text-[10px] text-gray-500 font-mono flex-1 max-w-md"
            style={{ background: "white", border: "1px solid #e5e7eb" }}
          >
            kobeai.school.tz{title === "Class Timetable" ? "/timetable" : "/exams"}
          </div>
        </div>
        <div style={{ height: "calc(100% - 28px)", overflow: "hidden" }}>{children}</div>
      </div>
      <div className="text-base font-semibold text-gray-700">{title}</div>
    </div>
  );
}

export function DashboardScreens() {
  return (
    <div className="min-h-screen bg-gray-100 p-10">
      <div className="max-w-[1280px] mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          KobeAI Teacher Dashboard — Timetable + Exam Mode
        </h1>
        <p className="text-sm text-gray-600 mb-8">
          Production-style mockups of the two new pages, brand green #00A86B / ink
          #1A1A2E. Matches the live React pages in <code>artifacts/teacher-dashboard/src/pages/</code>.
        </p>
        <div className="flex flex-col gap-12 items-center">
          <Frame title="Class Timetable">
            <TimetablePage />
          </Frame>
          <Frame title="Exam Mode">
            <ExamsPage />
          </Frame>
        </div>
      </div>
    </div>
  );
}
