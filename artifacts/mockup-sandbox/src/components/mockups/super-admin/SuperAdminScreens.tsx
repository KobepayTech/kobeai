import type { ReactNode } from "react";

const PRIMARY = "#00A86B";
const NAVY = "#1A1A2E";
const BG = "#F4F6F8";

function Shell({ active, children }: { active: string; children: ReactNode }) {
  const nav = [
    { id: "schools", label: "Schools", icon: "🏫" },
    { id: "market", label: "Question Market", icon: "🎯" },
    { id: "ledger", label: "KP Ledger", icon: "📒" },
    { id: "bursar", label: "Bursar Payments", icon: "💰" },
    { id: "tenants", label: "Tenants & Plans", icon: "🪪" },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];
  return (
    <div className="flex h-[820px] w-[1280px] overflow-hidden" style={{ background: BG }}>
      <aside
        className="w-[230px] flex flex-col text-white"
        style={{ background: NAVY }}
      >
        <div className="px-5 py-5 border-b border-white/10">
          <div className="text-[11px] uppercase tracking-wider text-white/50">
            KobeAI
          </div>
          <div className="text-[15px] font-bold">Super Admin</div>
        </div>
        <nav className="flex-1 px-2 py-3">
          {nav.map((n) => {
            const isActive = n.id === active;
            return (
              <div
                key={n.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg mb-1 text-[13px]"
                style={{
                  background: isActive ? PRIMARY : "transparent",
                  color: isActive ? "#0a1422" : "#cfd6e0",
                  fontWeight: isActive ? 700 : 500,
                }}
              >
                <span className="text-[14px]">{n.icon}</span>
                <span>{n.label}</span>
              </div>
            );
          })}
        </nav>
        <div className="px-4 py-3 border-t border-white/10 text-[11px] text-white/50">
          v1.0 · 100 schools · 38,420 students
        </div>
      </aside>
      <main className="flex-1 overflow-hidden flex flex-col">{children}</main>
    </div>
  );
}

function TopBar({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-center justify-between px-8 py-5 bg-white border-b border-gray-200">
      <div>
        <div className="text-[20px] font-bold" style={{ color: NAVY }}>
          {title}
        </div>
        <div className="text-[12px] text-gray-500">{subtitle}</div>
      </div>
      <div className="flex items-center gap-3">
        <input
          placeholder="Search schools, students, payments…"
          className="px-3 py-2 text-[12px] rounded-lg border border-gray-200 w-[280px]"
        />
        <div
          className="rounded-full flex items-center justify-center text-[12px] font-bold text-white"
          style={{ width: 36, height: 36, background: PRIMARY }}
        >
          SA
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  delta,
  positive = true,
}: {
  label: string;
  value: string;
  delta: string;
  positive?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl p-4 border border-gray-100">
      <div className="text-[11px] text-gray-500 uppercase tracking-wide">
        {label}
      </div>
      <div className="text-[22px] font-bold mt-1" style={{ color: NAVY }}>
        {value}
      </div>
      <div
        className="text-[11px] font-medium mt-0.5"
        style={{ color: positive ? PRIMARY : "#d63b3b" }}
      >
        {delta}
      </div>
    </div>
  );
}

function SchoolsScreen() {
  const schools = [
    { name: "Karatu Secondary", region: "Arusha", students: 624, status: "active", paid: "TSh 31.2M", kp: "1.4M" },
    { name: "Mzumbe Boys", region: "Morogoro", students: 812, status: "active", paid: "TSh 40.6M", kp: "2.1M" },
    { name: "Loyola Dar", region: "Dar es Salaam", students: 1104, status: "active", paid: "TSh 55.2M", kp: "3.0M" },
    { name: "St. Mary's Mwanza", region: "Mwanza", students: 478, status: "trial", paid: "TSh 0", kp: "12K" },
    { name: "Iringa Girls", region: "Iringa", students: 540, status: "active", paid: "TSh 27.0M", kp: "980K" },
    { name: "Kilakala Sec.", region: "Morogoro", students: 388, status: "overdue", paid: "TSh 11.6M", kp: "420K" },
    { name: "Tabora Boys", region: "Tabora", students: 702, status: "active", paid: "TSh 35.1M", kp: "1.8M" },
    { name: "Pugu Sec.", region: "Pwani", students: 412, status: "active", paid: "TSh 20.6M", kp: "640K" },
  ];
  const statusStyle = (s: string) => {
    if (s === "active") return { bg: "#E6F7EF", fg: "#006d44" };
    if (s === "trial") return { bg: "#FFF4D6", fg: "#8a6500" };
    return { bg: "#FFE5E5", fg: "#a02020" };
  };
  return (
    <>
      <TopBar
        title="Schools"
        subtitle="100 schools across 14 regions · 38,420 students"
      />
      <div className="px-8 py-5 grid grid-cols-4 gap-3">
        <StatCard label="Active schools" value="92" delta="+4 this month" />
        <StatCard label="Students online" value="38,420" delta="+1,210 this week" />
        <StatCard label="Bursar paid (MTD)" value="TSh 1.84B" delta="+12.4% MoM" />
        <StatCard label="KP in circulation" value="48.2M" delta="+3.1M this week" />
      </div>
      <div className="px-8 pb-6 flex-1 overflow-hidden">
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex gap-2">
              {["All", "Active", "Trial", "Overdue"].map((t, i) => (
                <button
                  key={t}
                  className="px-3 py-1.5 text-[11px] rounded-lg"
                  style={{
                    background: i === 0 ? NAVY : "#f0f2f5",
                    color: i === 0 ? "white" : "#5a6270",
                    fontWeight: 600,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <button
              className="px-3 py-1.5 text-[11px] rounded-lg font-semibold"
              style={{ background: PRIMARY, color: "#0a1422" }}
            >
              + Onboard school
            </button>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-gray-500 text-[10px] uppercase tracking-wider">
                <th className="px-4 py-2.5">School</th>
                <th className="px-4 py-2.5">Region</th>
                <th className="px-4 py-2.5">Students</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Bursar paid (MTD)</th>
                <th className="px-4 py-2.5">KP issued</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {schools.map((s) => {
                const st = statusStyle(s.status);
                return (
                  <tr key={s.name} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-semibold" style={{ color: NAVY }}>
                      {s.name}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{s.region}</td>
                    <td className="px-4 py-3 text-gray-700">{s.students}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase"
                        style={{ background: st.bg, color: st.fg }}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium" style={{ color: NAVY }}>
                      {s.paid}
                    </td>
                    <td className="px-4 py-3" style={{ color: PRIMARY, fontWeight: 600 }}>
                      {s.kp}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button className="text-[11px] font-semibold" style={{ color: PRIMARY }}>
                        Manage →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MarketAdminScreen() {
  const questions = [
    { id: 214, subj: "Math · Form 3", text: "Solve for x: 2x² + 5x − 3 = 0", price: 10, reward: 500, locks: 4, solved: 38, status: "live" },
    { id: 213, subj: "Physics · Form 4", text: "State Newton's third law with two examples.", price: 10, reward: 500, locks: 1, solved: 22, status: "live" },
    { id: 212, subj: "Biology · Form 2", text: "Name the four chambers of the human heart.", price: 10, reward: 500, locks: 0, solved: 71, status: "live" },
    { id: 211, subj: "Kiswahili · Form 1", text: "Andika sentensi tatu kwa wakati uliopita.", price: 10, reward: 500, locks: 2, solved: 14, status: "live" },
    { id: 210, subj: "History · Form 4", text: "Discuss the causes of the Maji Maji war.", price: 25, reward: 1500, locks: 0, solved: 9, status: "draft" },
    { id: 209, subj: "Chemistry · Form 3", text: "Balance: Fe + O₂ → Fe₂O₃", price: 10, reward: 500, locks: 0, solved: 56, status: "archived" },
  ];
  const statusStyle = (s: string) => {
    if (s === "live") return { bg: "#E6F7EF", fg: "#006d44" };
    if (s === "draft") return { bg: "#E5EEFF", fg: "#1a4ba0" };
    return { bg: "#EFEFEF", fg: "#666" };
  };
  return (
    <>
      <TopBar
        title="Question Market"
        subtitle="You set the questions · students lock for KP · correct answer wins KP reward"
      />
      <div className="px-8 py-5 grid grid-cols-4 gap-3">
        <StatCard label="Live questions" value="142" delta="+8 today" />
        <StatCard label="Locks (last 24h)" value="3,418" delta="+22%" />
        <StatCard label="Avg solve rate" value="61%" delta="−3pt" positive={false} />
        <StatCard label="KP awarded today" value="284,500" delta="+18%" />
      </div>
      <div className="px-8 pb-6 flex-1 overflow-hidden">
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="text-[12px] text-gray-600">
              <span className="font-semibold" style={{ color: NAVY }}>
                Lock cost:
              </span>{" "}
              10 KP · <span className="font-semibold" style={{ color: NAVY }}>
                Reward:
              </span>{" "}
              500 KP · <span className="font-semibold" style={{ color: NAVY }}>
                Lock window:
              </span>{" "}
              5 min
            </div>
            <div className="flex gap-2">
              <button
                className="px-3 py-1.5 text-[11px] rounded-lg font-semibold border border-gray-300"
                style={{ color: NAVY }}
              >
                Bulk import CSV
              </button>
              <button
                className="px-3 py-1.5 text-[11px] rounded-lg font-semibold"
                style={{ background: PRIMARY, color: "#0a1422" }}
              >
                + New question
              </button>
            </div>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-gray-500 text-[10px] uppercase tracking-wider">
                <th className="px-4 py-2.5">#</th>
                <th className="px-4 py-2.5">Subject</th>
                <th className="px-4 py-2.5">Question</th>
                <th className="px-4 py-2.5">Lock</th>
                <th className="px-4 py-2.5">Reward</th>
                <th className="px-4 py-2.5">Active locks</th>
                <th className="px-4 py-2.5">Solved</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => {
                const st = statusStyle(q.status);
                return (
                  <tr key={q.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-mono text-gray-500">#{q.id}</td>
                    <td className="px-4 py-3 font-medium" style={{ color: NAVY }}>
                      {q.subj}
                    </td>
                    <td className="px-4 py-3 text-gray-700 max-w-[280px] truncate">
                      {q.text}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{q.price} KP</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: PRIMARY }}>
                      +{q.reward} KP
                    </td>
                    <td className="px-4 py-3 text-gray-700">{q.locks}</td>
                    <td className="px-4 py-3 text-gray-700">{q.solved}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase"
                        style={{ background: st.bg, color: st.fg }}
                      >
                        {q.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button className="text-[11px] font-semibold" style={{ color: PRIMARY }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function BursarPaymentsScreen() {
  const payments = [
    { id: "PAY-9821", school: "Loyola Dar", date: "17 Apr 14:08", amount: "TSh 4,200,000", method: "M-Pesa B2B", status: "success", students: 84 },
    { id: "PAY-9820", school: "Mzumbe Boys", date: "17 Apr 13:55", amount: "TSh 3,100,000", method: "Bank transfer", status: "success", students: 62 },
    { id: "PAY-9819", school: "Karatu Secondary", date: "17 Apr 12:31", amount: "TSh 1,550,000", method: "M-Pesa B2B", status: "success", students: 31 },
    { id: "PAY-9818", school: "Kilakala Sec.", date: "17 Apr 11:02", amount: "TSh 900,000", method: "M-Pesa B2B", status: "pending", students: 18 },
    { id: "PAY-9817", school: "Tabora Boys", date: "16 Apr 18:44", amount: "TSh 2,800,000", method: "Bank transfer", status: "success", students: 56 },
    { id: "PAY-9816", school: "St. Mary's Mwanza", date: "16 Apr 16:12", amount: "TSh 600,000", method: "M-Pesa B2B", status: "failed", students: 12 },
  ];
  const statusStyle = (s: string) => {
    if (s === "success") return { bg: "#E6F7EF", fg: "#006d44" };
    if (s === "pending") return { bg: "#FFF4D6", fg: "#8a6500" };
    return { bg: "#FFE5E5", fg: "#a02020" };
  };
  return (
    <>
      <TopBar
        title="Bursar Payments"
        subtitle="School bursars top up student subscriptions in bulk · M-Pesa B2B + bank transfer"
      />
      <div className="px-8 py-5 grid grid-cols-4 gap-3">
        <StatCard label="Today (settled)" value="TSh 11.65M" delta="+TSh 4.2M vs yest." />
        <StatCard label="Pending settlement" value="TSh 900K" delta="1 payment" positive={false} />
        <StatCard label="MTD total" value="TSh 1.84B" delta="100 schools paying" />
        <StatCard label="KP grants triggered" value="1,164,500" delta="100 KP × students" />
      </div>
      <div className="px-8 pb-6 flex-1 overflow-hidden grid grid-cols-3 gap-4">
        <div className="col-span-2 bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="text-[13px] font-semibold" style={{ color: NAVY }}>
              Recent bursar payments
            </div>
            <button className="text-[11px] font-semibold" style={{ color: PRIMARY }}>
              Export CSV
            </button>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-gray-500 text-[10px] uppercase tracking-wider">
                <th className="px-4 py-2.5">Ref</th>
                <th className="px-4 py-2.5">School</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Amount (TSh)</th>
                <th className="px-4 py-2.5">Method</th>
                <th className="px-4 py-2.5">Students</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const st = statusStyle(p.status);
                return (
                  <tr key={p.id} className="border-t border-gray-100">
                    <td className="px-4 py-3 font-mono text-gray-500">{p.id}</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: NAVY }}>
                      {p.school}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{p.date}</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: NAVY }}>
                      {p.amount}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{p.method}</td>
                    <td className="px-4 py-3 text-gray-700">{p.students}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase"
                        style={{ background: st.bg, color: st.fg }}
                      >
                        {p.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <div className="text-[13px] font-semibold mb-3" style={{ color: NAVY }}>
            Reconcile payment
          </div>
          <div className="text-[11px] text-gray-500 mb-1">School</div>
          <div className="text-[13px] font-semibold mb-3" style={{ color: NAVY }}>
            Kilakala Sec. (PAY-9818)
          </div>
          <div className="text-[11px] text-gray-500 mb-1">Bursar phone</div>
          <div className="text-[13px] mb-3 text-gray-700">+255 712 345 678</div>
          <div className="text-[11px] text-gray-500 mb-1">M-Pesa transaction</div>
          <div className="text-[13px] font-mono mb-3 text-gray-700">SFE7H3X912</div>
          <div className="text-[11px] text-gray-500 mb-1">Will credit</div>
          <div
            className="rounded-lg p-3 mb-4"
            style={{ background: "#E6F7EF" }}
          >
            <div className="text-[11px] text-gray-700">18 students × 100 KP</div>
            <div className="text-[18px] font-bold" style={{ color: "#006d44" }}>
              +1,800 KP
            </div>
          </div>
          <button
            className="w-full rounded-lg py-2.5 text-[12px] font-semibold mb-2"
            style={{ background: PRIMARY, color: "#0a1422" }}
          >
            Confirm & settle
          </button>
          <button
            className="w-full rounded-lg py-2.5 text-[12px] font-semibold"
            style={{ background: "#FFE5E5", color: "#a02020" }}
          >
            Reject
          </button>
        </div>
      </div>
    </>
  );
}

function GlobalLedgerScreen() {
  const rows = [
    { time: "14:09:21", school: "Loyola Dar", student: "STU-3041", delta: +500, reason: "Market: correct Q#214", balance: 5550 },
    { time: "14:09:18", school: "Loyola Dar", student: "STU-3041", delta: -10, reason: "Market: lock Q#214", balance: 5050 },
    { time: "14:08:55", school: "Karatu Secondary", student: "TEST003", delta: +100, reason: "Membership grant", balance: 100 },
    { time: "14:07:14", school: "Mzumbe Boys", student: "STU-2188", delta: +500, reason: "Market: correct Q#212", balance: 9120 },
    { time: "14:06:02", school: "Iringa Girls", student: "STU-1822", delta: -10, reason: "Market: lock Q#213", balance: 3290 },
    { time: "14:05:47", school: "Tabora Boys", student: "STU-4011", delta: +50, reason: "Daily check-in", balance: 1840 },
    { time: "14:04:30", school: "Karatu Secondary", student: "TEST001", delta: +100, reason: "Membership grant", balance: 290 },
    { time: "14:03:11", school: "Pugu Sec.", student: "STU-905", delta: +250, reason: "Badge: Question Hunter", balance: 4710 },
  ];
  return (
    <>
      <TopBar
        title="KP Ledger (global)"
        subtitle="Append-only audit trail · every credit & debit across all 100 schools"
      />
      <div className="px-8 py-5 grid grid-cols-4 gap-3">
        <StatCard label="Entries (24h)" value="48,219" delta="+11%" />
        <StatCard label="Net KP issued (24h)" value="+412,800" delta="reward > lock cost" />
        <StatCard label="Pending grants" value="38" delta="awaiting onboarding" positive={false} />
        <StatCard label="Conservation" value="✓ balanced" delta="Σ ledger = Σ balances" />
      </div>
      <div className="px-8 pb-6 flex-1 overflow-hidden">
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex gap-2">
              {["All schools", "Karatu", "Mzumbe", "Loyola", "+97 more"].map((t, i) => (
                <button
                  key={t}
                  className="px-3 py-1.5 text-[11px] rounded-lg"
                  style={{
                    background: i === 0 ? NAVY : "#f0f2f5",
                    color: i === 0 ? "white" : "#5a6270",
                    fontWeight: 600,
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-gray-500">
              Live · auto-refreshing every 5s
            </div>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-gray-500 text-[10px] uppercase tracking-wider">
                <th className="px-4 py-2.5">Time</th>
                <th className="px-4 py-2.5">School</th>
                <th className="px-4 py-2.5">Student</th>
                <th className="px-4 py-2.5">Δ KP</th>
                <th className="px-4 py-2.5">Reason</th>
                <th className="px-4 py-2.5 text-right">Balance after</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-mono text-gray-500">{r.time}</td>
                  <td className="px-4 py-3 font-medium" style={{ color: NAVY }}>
                    {r.school}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-700">{r.student}</td>
                  <td
                    className="px-4 py-3 font-bold"
                    style={{ color: r.delta > 0 ? PRIMARY : "#d63b3b" }}
                  >
                    {r.delta > 0 ? "+" : ""}
                    {r.delta}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{r.reason}</td>
                  <td className="px-4 py-3 text-right font-semibold" style={{ color: NAVY }}>
                    {r.balance.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function SuperAdminGallery() {
  return (
    <div className="min-h-screen bg-gray-100 p-6 flex flex-col items-center gap-10">
      <div className="text-center max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          KobeAI Super Admin — central control plane
        </h1>
        <p className="text-sm text-gray-600">
          Single operator (you) running the Question Market across 100 schools ·
          school bursars pay subscriptions in bulk · KP economy globally regulated
        </p>
      </div>

      <div className="text-center">
        <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2">
          1 · Schools overview
        </div>
        <div
          className="shadow-2xl rounded-xl overflow-hidden"
          style={{ boxShadow: "0 30px 60px rgba(0,0,0,0.15)" }}
        >
          <Shell active="schools">
            <SchoolsScreen />
          </Shell>
        </div>
      </div>

      <div className="text-center">
        <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2">
          2 · Question Market admin (super-admin only)
        </div>
        <div
          className="shadow-2xl rounded-xl overflow-hidden"
          style={{ boxShadow: "0 30px 60px rgba(0,0,0,0.15)" }}
        >
          <Shell active="market">
            <MarketAdminScreen />
          </Shell>
        </div>
      </div>

      <div className="text-center">
        <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2">
          3 · Bursar payments (school-level bulk top-up)
        </div>
        <div
          className="shadow-2xl rounded-xl overflow-hidden"
          style={{ boxShadow: "0 30px 60px rgba(0,0,0,0.15)" }}
        >
          <Shell active="bursar">
            <BursarPaymentsScreen />
          </Shell>
        </div>
      </div>

      <div className="text-center">
        <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2">
          4 · Global KP ledger
        </div>
        <div
          className="shadow-2xl rounded-xl overflow-hidden"
          style={{ boxShadow: "0 30px 60px rgba(0,0,0,0.15)" }}
        >
          <Shell active="ledger">
            <GlobalLedgerScreen />
          </Shell>
        </div>
      </div>
    </div>
  );
}
