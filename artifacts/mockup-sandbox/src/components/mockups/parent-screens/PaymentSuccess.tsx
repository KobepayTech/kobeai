const PRIMARY = "#00A86B";
const NAVY = "#1A1A2E";

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative overflow-hidden shadow-2xl bg-white"
        style={{
          width: 360,
          height: 740,
          border: "12px solid #111",
          borderRadius: 44,
          boxShadow: "0 30px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 z-10"
          style={{
            top: 8,
            width: 110,
            height: 22,
            background: "#111",
            borderRadius: 12,
          }}
        />
        <div className="w-full h-full overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="flex justify-between items-center px-6 pt-3 pb-1 text-[11px] font-medium text-gray-700">
      <span>9:41</span>
      <span className="flex gap-1 items-center">
        <span>•••</span>
        <span>📶</span>
        <span>🔋</span>
      </span>
    </div>
  );
}

function PaymentSuccessScreen() {
  return (
    <div className="flex flex-col h-full" style={{ background: "#F7F9F7" }}>
      <StatusBar />
      <div className="flex-1 flex flex-col px-6 pt-6">
        <button className="text-left text-[13px] text-gray-500 mb-6">
          ← Wallet
        </button>
        <div className="flex flex-col items-center text-center">
          <div
            className="rounded-full flex items-center justify-center mb-4"
            style={{
              width: 86,
              height: 86,
              background: PRIMARY,
              boxShadow: `0 12px 30px ${PRIMARY}55`,
            }}
          >
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12.5l4.5 4.5L19 7"
                stroke="white"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="text-[22px] font-bold" style={{ color: NAVY }}>
            Payment successful
          </div>
          <div className="text-[13px] text-gray-500 mt-1">
            M-Pesa receipt SFE7H3X912
          </div>
        </div>

        <div
          className="rounded-2xl p-5 mt-6"
          style={{ background: "white", boxShadow: "0 4px 14px rgba(0,0,0,0.05)" }}
        >
          <div className="flex justify-between items-baseline mb-3">
            <span className="text-[12px] text-gray-500 uppercase tracking-wide">
              Plan
            </span>
            <span className="text-[14px] font-semibold" style={{ color: NAVY }}>
              Monthly · KobeAI Pro
            </span>
          </div>
          <div className="flex justify-between items-baseline mb-3">
            <span className="text-[12px] text-gray-500 uppercase tracking-wide">
              Amount
            </span>
            <span className="text-[20px] font-bold" style={{ color: NAVY }}>
              TSh 50,000
            </span>
          </div>
          <div className="flex justify-between items-baseline mb-3">
            <span className="text-[12px] text-gray-500 uppercase tracking-wide">
              Student
            </span>
            <span className="text-[14px] font-semibold" style={{ color: NAVY }}>
              Charlie · TEST003
            </span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-[12px] text-gray-500 uppercase tracking-wide">
              Active until
            </span>
            <span className="text-[14px] font-semibold" style={{ color: NAVY }}>
              17 May 2026
            </span>
          </div>
        </div>

        <div
          className="rounded-2xl p-4 mt-4 flex items-center gap-3"
          style={{
            background: `linear-gradient(135deg, ${PRIMARY} 0%, #008A57 100%)`,
            color: "white",
          }}
        >
          <div
            className="rounded-full flex items-center justify-center text-[22px] font-bold"
            style={{
              width: 52,
              height: 52,
              background: "rgba(255,255,255,0.18)",
            }}
          >
            KP
          </div>
          <div className="flex-1">
            <div className="text-[11px] opacity-80 uppercase tracking-wide">
              Bonus credited to Charlie
            </div>
            <div className="text-[20px] font-bold leading-tight">+100 KP</div>
            <div className="text-[10px] opacity-90">
              Your child will see this on their watch instantly.
            </div>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 mt-3 text-[11px] text-gray-600 flex items-start gap-2"
          style={{ background: "#FFF8E5", border: "1px solid #F2D87E" }}
        >
          <span>💡</span>
          <span>
            KP (KobeAI Points) let your child unlock practice questions and earn
            badges in class — they can't be exchanged for money.
          </span>
        </div>

        <div className="flex-1" />
        <button
          className="rounded-2xl py-4 text-[15px] font-semibold mb-3"
          style={{ background: NAVY, color: "white" }}
        >
          Done
        </button>
        <button
          className="text-center text-[13px] py-2 mb-4"
          style={{ color: PRIMARY }}
        >
          View receipt
        </button>
      </div>
    </div>
  );
}

export default function ParentPaymentSuccessGallery() {
  return (
    <div className="min-h-screen bg-gray-100 p-10">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          Parent App — payment success
        </h1>
        <p className="text-sm text-gray-600 mb-8">
          PWA · brand green #00A86B / navy #1A1A2E · TSh fiat + KP reward visible
        </p>
        <div className="flex justify-center">
          <PhoneFrame>
            <PaymentSuccessScreen />
          </PhoneFrame>
        </div>
      </div>
    </div>
  );
}
