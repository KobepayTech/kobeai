import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";

export function Layout({ children }: { children: ReactNode }) {
  const { advertiser, logout } = useAuth();
  const [loc] = useLocation();

  const nav = [
    { href: "/dashboard", label: "Campaigns" },
    { href: "/stats", label: "Stats" },
    { href: "/wallet", label: "Wallet" },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-navy text-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-brand flex items-center justify-center font-black">K</div>
              <div>
                <div className="font-bold leading-tight">KobeAI</div>
                <div className="text-xs text-white/60 leading-tight">Advertiser Portal</div>
              </div>
            </Link>
            <nav className="flex gap-1">
              {nav.map((n) => {
                const active = loc === n.href || loc.startsWith(n.href + "/");
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                      active ? "bg-white/10 text-white" : "text-white/70 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs text-white/60">{advertiser?.company_name}</div>
              <div className="text-sm font-semibold text-brand">
                {advertiser ? `TSh ${advertiser.balance_tsh.toLocaleString()}` : "—"}
              </div>
            </div>
            <button onClick={logout} className="text-xs text-white/70 hover:text-white">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">{children}</main>
    </div>
  );
}
