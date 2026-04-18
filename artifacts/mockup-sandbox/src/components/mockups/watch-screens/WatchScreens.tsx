import type { ReactNode } from "react";

const PRIMARY = "#00A86B";
const BG = "#0E0E14";

// Rectangular 2.01" smartwatch face (e.g. Redmi Watch 4 / Amazfit-class).
// Real panel is ~410 x 502 px; we render at that ratio with rounded corners.
function Watch({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative overflow-hidden shadow-2xl"
        style={{
          width: 320,
          height: 392,
          background: BG,
          border: "10px solid #1a1a1a",
          borderRadius: 44,
          boxShadow: "0 0 0 4px #2a2a2a, 0 30px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* Side button (right edge) for the rectangular form factor */}
        <div
          aria-hidden
          className="absolute"
          style={{
            right: -14,
            top: 130,
            width: 6,
            height: 50,
            background: "#2a2a2a",
            borderRadius: 3,
          }}
        />
        <div className="absolute inset-0">
          <div className="w-full h-full px-4 py-3 text-white text-[13px] font-sans flex flex-col">
            <div className="text-center text-[10px] text-gray-400 mb-1.5">10:32</div>
            {children}
          </div>
        </div>
      </div>
      <div className="text-sm font-semibold text-gray-700">{title}</div>
    </div>
  );
}

function MenuCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      className="rounded-2xl px-3 py-2 mb-1.5"
      style={{ background: "#1c1c24" }}
    >
      <div className="text-[12px] font-semibold" style={{ color: PRIMARY }}>
        {title}
      </div>
      <div className="text-[9px] text-gray-400 leading-tight">{subtitle}</div>
    </div>
  );
}

function HomeScreen() {
  return (
    <>
      <div className="text-center mb-2">
        <div className="text-[10px] text-gray-400">Hi, John</div>
        <div className="text-[18px] font-bold" style={{ color: PRIMARY }}>
          5,050 KP
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <MenuCard title="Ask KobeAI" subtitle="Get help with homework" />
        <MenuCard title="Quizzes" subtitle="Practice and earn points" />
        <MenuCard title="Leaderboard" subtitle="See your class ranking" />
        <MenuCard title="Check In" subtitle="Mark daily attendance" />
      </div>
    </>
  );
}

function LeaderboardRow({
  rank,
  name,
  pts,
  avg,
  taken,
  me,
}: {
  rank: number;
  name: string;
  pts: number;
  avg: number;
  taken: number;
  me?: boolean;
}) {
  return (
    <div
      className="rounded-xl flex items-center gap-2 px-2 py-1.5 mb-1"
      style={{ background: "#1c1c24" }}
    >
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
        style={{ background: me ? PRIMARY : "#3a3a3a" }}
      >
        {rank}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] font-semibold truncate"
          style={{ color: me ? PRIMARY : "white" }}
        >
          {me ? "You" : name}
        </div>
        <div className="text-[8px] text-gray-400">
          {taken} quizzes · avg {avg}%
        </div>
      </div>
      <div
        className="text-[14px] font-bold"
        style={{ color: me ? PRIMARY : "white" }}
      >
        {pts}
      </div>
    </div>
  );
}

function LeaderboardScreen() {
  return (
    <>
      <div className="text-center mb-1.5">
        <div
          className="text-[12px] font-semibold inline-flex items-center gap-1"
          style={{ color: PRIMARY }}
        >
          🏆 Class leaderboard
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <LeaderboardRow rank={1} name="Amani M." pts={285} avg={95} taken={3} />
        <LeaderboardRow rank={2} name="Neema K." pts={240} avg={80} taken={3} />
        <LeaderboardRow rank={3} name="John Doe" pts={220} avg={73} taken={3} me />
        <LeaderboardRow rank={4} name="Baraka J." pts={180} avg={60} taken={3} />
      </div>
    </>
  );
}

function QuizListScreen() {
  return (
    <>
      <div className="text-center text-[12px] font-semibold mb-1.5" style={{ color: PRIMARY }}>
        Quizzes
      </div>
      <div className="flex-1 overflow-hidden">
        {[
          { t: "Mathematics Basics", s: "Mathematics", q: 5, p: 50, d: 15 },
          { t: "Science - Biology", s: "Science", q: 3, p: 30, d: 10 },
          { t: "Tanzania History", s: "History", q: 4, p: 40, d: 12 },
        ].map((q, i) => (
          <div
            key={i}
            className="rounded-2xl px-3 py-2 mb-1.5"
            style={{ background: "#1c1c24" }}
          >
            <div className="text-[12px] font-semibold" style={{ color: PRIMARY }}>
              {q.t}
            </div>
            <div className="text-[9px] text-gray-400">{q.s}</div>
            <div className="flex gap-2 text-[8px] text-gray-300 mt-0.5">
              <span>Q {q.q}</span>
              <span>Pts {q.p}</span>
              <span>{q.d}m</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function QuizScreen() {
  return (
    <>
      <div className="text-center text-[10px] text-gray-400 mb-1">
        Question 2 of 5
      </div>
      <div
        className="text-[13px] font-semibold text-center mb-3 leading-snug"
        style={{ color: "white" }}
      >
        What is 8 × 7?
      </div>
      <div className="flex-1 flex flex-col gap-1.5">
        {[
          { l: "A", t: "48" },
          { l: "B", t: "54" },
          { l: "C", t: "56", correct: true },
          { l: "D", t: "64" },
        ].map((o) => (
          <div
            key={o.l}
            className="rounded-full px-3 py-1.5 text-[11px] flex items-center gap-2"
            style={{
              background: o.correct ? PRIMARY : "#1c1c24",
              color: o.correct ? "white" : "#ddd",
              fontWeight: o.correct ? 700 : 400,
            }}
          >
            <span className="font-bold">{o.l})</span>
            <span>{o.t}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function ChatScreen() {
  return (
    <>
      <div className="text-center text-[10px] mb-1" style={{ color: PRIMARY }}>
        🎤 KobeAI Tutor
      </div>
      <div className="flex-1 flex flex-col gap-1.5 overflow-hidden">
        <div
          className="rounded-2xl rounded-tl-sm px-3 py-1.5 text-[10px] self-start max-w-[85%]"
          style={{ background: "#1c1c24", color: "#ddd" }}
        >
          What is photosynthesis?
        </div>
        <div
          className="rounded-2xl rounded-tr-sm px-3 py-1.5 text-[10px] self-end max-w-[85%]"
          style={{ background: PRIMARY, color: "white" }}
        >
          Photosynthesis ni mchakato ambao mimea hutumia mwanga wa jua...
        </div>
        <div
          className="rounded-2xl rounded-tl-sm px-3 py-1.5 text-[10px] self-start max-w-[85%]"
          style={{ background: "#1c1c24", color: "#ddd" }}
        >
          Tell me more
        </div>
      </div>
      <div
        className="rounded-full px-3 py-1.5 text-[10px] text-gray-500 mt-1"
        style={{ background: "#1c1c24" }}
      >
        Type or speak...
      </div>
    </>
  );
}

function SubscriptionScreen() {
  return (
    <>
      <div className="text-center text-[12px] font-semibold mb-2" style={{ color: PRIMARY }}>
        My Plan
      </div>
      <div
        className="rounded-2xl p-3 text-center mb-2"
        style={{ background: "#1c1c24" }}
      >
        <div className="text-[10px] text-gray-400">Premium</div>
        <div className="text-[14px] font-bold text-white">Active</div>
        <div className="text-[9px] text-gray-400 mt-1">Renews May 2</div>
      </div>
      <div
        className="rounded-xl p-2 text-[9px] text-center"
        style={{ background: "#2a1a1a", color: "#ffaa66" }}
      >
        Ask Mum to renew at:
        <div className="font-bold text-[11px]" style={{ color: PRIMARY }}>
          +255 712 345 678
        </div>
      </div>
    </>
  );
}

function TimetableScreen() {
  const periods = [
    { time: "07:30–08:00", subject: "Assembly", room: "Hall", current: false },
    { time: "08:00–08:40", subject: "Mathematics", room: "Room 12", current: true },
    { time: "08:40–09:20", subject: "Kiswahili", room: "Room 12", current: false },
    { time: "09:20–10:00", subject: "Science", room: "Lab", current: false },
  ];
  return (
    <>
      <div className="text-center text-[12px] font-semibold mb-1.5" style={{ color: PRIMARY }}>
        Friday
      </div>
      <div className="flex-1 flex flex-col gap-1.5 overflow-hidden">
        {periods.map((p) => (
          <div
            key={p.subject}
            className="rounded-xl px-2.5 py-1.5"
            style={{ background: p.current ? "#0d3d29" : "#1c1c24" }}
          >
            <div className="flex items-center justify-between">
              <div
                className="text-[11px] font-semibold"
                style={{ color: p.current ? PRIMARY : "white" }}
              >
                {p.subject}
              </div>
              {p.current && (
                <div className="text-[8px] font-bold" style={{ color: PRIMARY }}>
                  NOW
                </div>
              )}
            </div>
            <div className="text-[9px] text-gray-400">{p.time} · {p.room}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function LoginScreen() {
  return (
    <>
      <div className="flex-1 flex flex-col items-center justify-center">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
          style={{ background: PRIMARY }}
        >
          <span className="text-[22px] font-black text-white">K</span>
        </div>
        <div className="text-[14px] font-bold text-white mb-0.5">KobeAI</div>
        <div className="text-[9px] text-gray-400 mb-4">Tap your watch to sign in</div>
        <div
          className="rounded-xl px-3 py-2 w-full mb-1.5"
          style={{ background: "#1c1c24" }}
        >
          <div className="text-[8px] text-gray-500">Student code</div>
          <div className="text-[12px] font-mono text-white tracking-wider">STU-7421</div>
        </div>
        <div
          className="rounded-xl px-3 py-2 w-full mb-3"
          style={{ background: "#1c1c24" }}
        >
          <div className="text-[8px] text-gray-500">PIN</div>
          <div className="text-[12px] font-mono text-white tracking-[6px]">• • • •</div>
        </div>
        <div
          className="rounded-full px-6 py-1.5 text-[11px] font-bold text-white w-full text-center"
          style={{ background: PRIMARY }}
        >
          Sign in
        </div>
      </div>
    </>
  );
}

function AttendanceScreen() {
  return (
    <>
      <div className="text-center text-[12px] font-semibold mb-2" style={{ color: PRIMARY }}>
        Daily Check-In
      </div>
      <div
        className="rounded-2xl p-3 text-center mb-2"
        style={{ background: "#1c1c24" }}
      >
        <div className="text-[9px] text-gray-400">Friday, 17 Apr 2026</div>
        <div className="text-[20px] font-bold text-white mt-0.5">07:48</div>
        <div className="text-[9px] mt-0.5" style={{ color: PRIMARY }}>
          ✓ On time
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="text-[9px] text-gray-500 mb-1 px-1">This week</div>
        {[
          { d: "Mon", t: "07:42", ok: true },
          { d: "Tue", t: "07:55", ok: true },
          { d: "Wed", t: "08:11", late: true },
          { d: "Thu", t: "07:39", ok: true },
        ].map((r) => (
          <div
            key={r.d}
            className="rounded-lg flex items-center justify-between px-2 py-1 mb-1"
            style={{ background: "#1c1c24" }}
          >
            <div className="text-[10px] text-gray-300">{r.d}</div>
            <div className="text-[10px] font-mono text-white">{r.t}</div>
            <div
              className="text-[9px] font-bold"
              style={{ color: r.late ? "#ffaa66" : PRIMARY }}
            >
              {r.late ? "LATE" : "OK"}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function WalletScreen() {
  return (
    <>
      <div className="text-center text-[10px] text-gray-400">Lunch wallet</div>
      <div className="text-center mb-3">
        <div className="text-[22px] font-bold" style={{ color: PRIMARY }}>
          TSh 4,500
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="text-[9px] text-gray-500 mb-1 px-1">Recent</div>
        {[
          { t: "Lunch — Ugali & beans", a: -1500, when: "Today 12:30" },
          { t: "Mum top-up", a: 5000, when: "Mon 06:15" },
          { t: "Snack — Mandazi", a: -500, when: "Fri 10:05" },
          { t: "Lunch — Pilau", a: -2000, when: "Fri 12:35" },
        ].map((r, i) => (
          <div
            key={i}
            className="rounded-lg flex items-center justify-between px-2 py-1 mb-1"
            style={{ background: "#1c1c24" }}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-white truncate">{r.t}</div>
              <div className="text-[8px] text-gray-500">{r.when}</div>
            </div>
            <div
              className="text-[11px] font-bold"
              style={{ color: r.a > 0 ? PRIMARY : "#ff8888" }}
            >
              {r.a > 0 ? "+" : ""}
              {r.a.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PrintScreen() {
  return (
    <>
      <div className="text-center text-[12px] font-semibold mb-1.5" style={{ color: PRIMARY }}>
        Print to NFC printer
      </div>
      <div className="text-center text-[9px] text-gray-400 mb-2">
        Tap watch on printer when ready
      </div>
      <div className="flex-1 overflow-hidden">
        {[
          { t: "Maths Worksheet 4", p: 2, sel: true },
          { t: "Kiswahili Insha", p: 1, sel: false },
          { t: "Biology Diagram", p: 3, sel: false },
        ].map((d) => (
          <div
            key={d.t}
            className="rounded-xl px-2.5 py-1.5 mb-1.5 flex items-center gap-2"
            style={{
              background: d.sel ? "#0d3d29" : "#1c1c24",
              border: d.sel ? `1px solid ${PRIMARY}` : "1px solid transparent",
            }}
          >
            <div
              className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]"
              style={{
                background: d.sel ? PRIMARY : "#3a3a3a",
                color: "white",
              }}
            >
              {d.sel ? "✓" : ""}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="text-[11px] font-semibold truncate"
                style={{ color: d.sel ? PRIMARY : "white" }}
              >
                {d.t}
              </div>
              <div className="text-[8px] text-gray-400">{d.p} pages</div>
            </div>
          </div>
        ))}
      </div>
      <div
        className="rounded-full px-3 py-1.5 text-[11px] font-bold text-white text-center mt-1"
        style={{ background: PRIMARY }}
      >
        📡 Tap to print
      </div>
    </>
  );
}

function BluetoothSetupScreen() {
  return (
    <>
      <div className="text-center text-[12px] font-semibold mb-2" style={{ color: PRIMARY }}>
        Bluetooth setup
      </div>
      <div className="flex-1 overflow-hidden">
        {[
          { name: "John's Earbuds", type: "Audio", paired: true },
          { name: "School Keyboard #14", type: "Keyboard", paired: true },
          { name: "Pico TWS", type: "Audio", scanning: true },
        ].map((d) => (
          <div
            key={d.name}
            className="rounded-xl px-2.5 py-1.5 mb-1.5"
            style={{ background: "#1c1c24" }}
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold text-white truncate flex-1">
                {d.name}
              </div>
              <div
                className="text-[8px] font-bold ml-1"
                style={{
                  color: d.paired ? PRIMARY : d.scanning ? "#ffaa66" : "#888",
                }}
              >
                {d.paired ? "PAIRED" : d.scanning ? "..." : "PAIR"}
              </div>
            </div>
            <div className="text-[9px] text-gray-400">{d.type}</div>
          </div>
        ))}
      </div>
      <div
        className="rounded-full px-3 py-1.5 text-[10px] text-center mt-1"
        style={{ background: "#1c1c24", color: "#ddd" }}
      >
        🔍 Scan again
      </div>
    </>
  );
}

function ExamCountdownScreen() {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center p-6"
      style={{ background: "#1a0000" }}
    >
      <div className="text-[10px] font-bold mb-1" style={{ color: PRIMARY }}>
        EXAM IN PROGRESS
      </div>
      <div className="text-[10px] text-white mb-3">Mid-term Maths</div>
      <div className="text-[42px] font-bold leading-none" style={{ color: "#FF6B6B" }}>
        4:32
      </div>
      <div className="text-[8px] text-gray-400 mt-3">Supervisor +5 min</div>
    </div>
  );
}

function MarketListScreen() {
  const items = [
    { subj: "MATH", prompt: "What is 7 × 8?", reward: 50, locked: false },
    { subj: "PHYS", prompt: "Unit of force is…", reward: 30, locked: true, owner: "Asha" },
    { subj: "CODE", prompt: "Big-O of binary search?", reward: 40, locked: false },
  ];
  return (
    <>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] text-gray-400">Market</div>
        <div className="text-[11px] font-bold" style={{ color: PRIMARY }}>
          150 KP
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {items.map((it, i) => (
          <div
            key={i}
            className="rounded-2xl px-2.5 py-1.5 mb-1.5"
            style={{ background: "#1c1c24" }}
          >
            <div className="flex items-center justify-between">
              <div
                className="text-[8px] font-bold tracking-wider"
                style={{ color: it.locked ? "#FF6B6B" : PRIMARY }}
              >
                {it.subj}
              </div>
              <div
                className="text-[9px] font-bold"
                style={{ color: PRIMARY }}
              >
                +{it.reward} KP
              </div>
            </div>
            <div className="text-[10px] text-white leading-tight mt-0.5">
              {it.prompt}
            </div>
            <div className="text-[8px] text-gray-500 mt-0.5">
              {it.locked ? `🔒 Locked by ${it.owner}` : "Tap to lock or answer"}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function MarketLockConfirmScreen() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-5">
      <div className="text-[9px] tracking-wider text-gray-400 mb-1">LOCK QUESTION</div>
      <div className="text-[12px] text-white text-center leading-tight mb-4">
        “What is 7 × 8?”
      </div>
      <div
        className="rounded-xl px-3 py-2 mb-3 w-full"
        style={{ background: "#1c1c24" }}
      >
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-400">Lock cost</span>
          <span className="text-white font-bold">−10 KP</span>
        </div>
        <div className="flex justify-between text-[10px] mt-0.5">
          <span className="text-gray-400">If you win</span>
          <span style={{ color: PRIMARY }} className="font-bold">+50 KP</span>
        </div>
        <div className="flex justify-between text-[10px] mt-0.5">
          <span className="text-gray-400">Time</span>
          <span className="text-white">5:00</span>
        </div>
      </div>
      <button
        className="w-full text-[11px] font-bold py-2 rounded-full"
        style={{ background: PRIMARY, color: "#000" }}
      >
        Lock & Answer
      </button>
      <div className="text-[8px] text-gray-500 mt-2">Balance after: 140 KP</div>
    </div>
  );
}

function MarketAnswerScreen() {
  const choices = ["54", "56", "58", "64"];
  const correct = 1;
  return (
    <>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[9px] text-gray-400">MATH · 4:47</div>
        <div className="text-[10px] font-bold" style={{ color: PRIMARY }}>
          +50 KP
        </div>
      </div>
      <div className="text-[13px] text-white text-center leading-tight my-2">
        What is 7 × 8?
      </div>
      <div className="flex-1 grid grid-cols-2 gap-1.5">
        {choices.map((c, i) => (
          <div
            key={i}
            className="flex items-center justify-center rounded-2xl text-[14px] font-bold"
            style={{
              background: i === correct ? PRIMARY : "#1c1c24",
              color: i === correct ? "#000" : "#fff",
            }}
          >
            {c}
          </div>
        ))}
      </div>
      <div className="text-[8px] text-gray-500 text-center mt-1">
        🔒 You hold the lock
      </div>
    </>
  );
}

export function WatchScreens() {
  return (
    <div className="min-h-screen bg-gray-100 p-10">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          KobeAI Wear OS — UI mockups
        </h1>
        <p className="text-sm text-gray-600 mb-8">
          Round 360×360 watch faces · brand green #00A86B · matches the Compose
          screens in <code>watch-app/</code>
        </p>
        <div className="grid grid-cols-3 gap-x-12 gap-y-12 justify-items-center">
          <Watch title="Sign in">
            <LoginScreen />
          </Watch>
          <Watch title="Home menu">
            <HomeScreen />
          </Watch>
          <Watch title="Daily check-in">
            <AttendanceScreen />
          </Watch>
          <Watch title="Chat / AI tutor">
            <ChatScreen />
          </Watch>
          <Watch title="Quiz list">
            <QuizListScreen />
          </Watch>
          <Watch title="Quiz question">
            <QuizScreen />
          </Watch>
          <Watch title="Leaderboard">
            <LeaderboardScreen />
          </Watch>
          <Watch title="Lunch wallet">
            <WalletScreen />
          </Watch>
          <Watch title="Print (NFC tap)">
            <PrintScreen />
          </Watch>
          <Watch title="Bluetooth setup">
            <BluetoothSetupScreen />
          </Watch>
          <Watch title="Timetable">
            <TimetableScreen />
          </Watch>
          <Watch title="Exam takeover">
            <ExamCountdownScreen />
          </Watch>
          <Watch title="Subscription">
            <SubscriptionScreen />
          </Watch>
          <Watch title="Market — questions">
            <MarketListScreen />
          </Watch>
          <Watch title="Market — lock & buy">
            <MarketLockConfirmScreen />
          </Watch>
          <Watch title="Market — answer">
            <MarketAnswerScreen />
          </Watch>
          <Watch title="KP balance & history">
            <KpHistoryScreen />
          </Watch>
          <Watch title="KP leaderboard">
            <KpLeaderboardScreen />
          </Watch>
          <Watch title="Badge earned (toast)">
            <BadgeToastScreen />
          </Watch>
        </div>
      </div>
    </div>
  );
}

function KpHistoryScreen() {
  const rows: Array<{ delta: number; reason: string; when: string }> = [
    { delta: +500, reason: "Correct answer", when: "2m ago" },
    { delta: -10, reason: "Locked Q#214", when: "3m ago" },
    { delta: +500, reason: "Correct answer", when: "12m ago" },
    { delta: -10, reason: "Locked Q#198", when: "13m ago" },
    { delta: +100, reason: "Membership grant", when: "yesterday" },
    { delta: +50, reason: "Daily check-in", when: "yesterday" },
  ];
  return (
    <>
      <div className="text-center mb-1">
        <div className="text-[9px] text-gray-400">Your KP</div>
        <div className="text-[22px] font-bold leading-none" style={{ color: PRIMARY }}>
          5,050
        </div>
        <div className="text-[8px] text-gray-500 mt-0.5">last 24h: +1,140</div>
      </div>
      <div className="flex-1 overflow-hidden mt-1">
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex items-center justify-between px-2 py-1 mb-1 rounded-lg"
            style={{ background: "#1c1c24" }}
          >
            <div className="min-w-0">
              <div className="text-[10px] text-white truncate">{r.reason}</div>
              <div className="text-[8px] text-gray-500">{r.when}</div>
            </div>
            <div
              className="text-[11px] font-bold ml-2"
              style={{ color: r.delta > 0 ? PRIMARY : "#ff6b6b" }}
            >
              {r.delta > 0 ? "+" : ""}
              {r.delta}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function KpLeaderboardScreen() {
  const rows = [
    { rank: 1, name: "Asha M.", kp: 8420, you: false },
    { rank: 2, name: "Juma K.", kp: 7150, you: false },
    { rank: 3, name: "You", kp: 5050, you: true },
    { rank: 4, name: "Neema P.", kp: 4900, you: false },
    { rank: 5, name: "Baraka L.", kp: 4710, you: false },
  ];
  return (
    <>
      <div className="text-center mb-1">
        <div className="text-[10px] text-gray-400">Form 3B · this week</div>
        <div className="text-[12px] font-semibold text-white">KP Leaderboard</div>
      </div>
      <div className="flex-1 overflow-hidden mt-1">
        {rows.map((r) => (
          <div
            key={r.rank}
            className="flex items-center px-2 py-1.5 mb-1 rounded-lg"
            style={{
              background: r.you ? PRIMARY : "#1c1c24",
              color: r.you ? "#0E0E14" : "white",
            }}
          >
            <div className="text-[11px] font-bold w-5">#{r.rank}</div>
            <div className="text-[11px] flex-1 truncate font-medium">{r.name}</div>
            <div className="text-[11px] font-bold">{r.kp.toLocaleString()}</div>
          </div>
        ))}
      </div>
      <div className="text-center text-[8px] text-gray-500 mt-1">
        Top 3 win bonus KP on Friday
      </div>
    </>
  );
}

function BadgeToastScreen() {
  return (
    <>
      <div className="flex-1 flex flex-col items-center justify-center -mt-2">
        <div
          className="rounded-full flex items-center justify-center mb-3"
          style={{
            width: 88,
            height: 88,
            background: `radial-gradient(circle at 30% 30%, ${PRIMARY}, #006d44)`,
            boxShadow: `0 0 32px ${PRIMARY}66`,
          }}
        >
          <div className="text-[40px]">🏆</div>
        </div>
        <div className="text-[10px] text-gray-400 uppercase tracking-wider">
          Badge unlocked
        </div>
        <div className="text-[15px] font-bold text-white mt-1">
          Question Hunter
        </div>
        <div className="text-[9px] text-gray-400 mt-0.5">
          Solved 10 market questions
        </div>
        <div
          className="mt-3 px-3 py-1 rounded-full text-[11px] font-bold"
          style={{ background: PRIMARY, color: "#0E0E14" }}
        >
          +250 KP bonus
        </div>
      </div>
      <div className="text-center text-[9px] text-gray-500 pb-1">
        Tap to dismiss
      </div>
    </>
  );
}
