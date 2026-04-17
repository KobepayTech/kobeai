import React from "react";
import { Link, useLocation } from "wouter";
import { Home, Wallet, Activity, Printer, ShieldCheck } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] w-full max-w-md mx-auto bg-gray-50 flex flex-col relative shadow-xl overflow-hidden border-x border-gray-200 sm:rounded-3xl sm:h-[850px] sm:my-8 sm:min-h-0">
      <main className="flex-1 overflow-y-auto pb-20 no-scrollbar">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}

function BottomNav() {
  const [location] = useLocation();

  const navItems = [
    { name: "Home", href: "/dashboard", icon: Home },
    { name: "Wallet", href: "/wallet", icon: Wallet },
    { name: "Pay", href: "/subscription", icon: ShieldCheck },
    { name: "Print", href: "/print", icon: Printer },
    { name: "Activity", href: "/activity", icon: Activity },
  ];

  return (
    <nav className="absolute bottom-0 w-full bg-white border-t border-gray-100 px-6 py-3 pb-safe z-50 flex justify-between items-center shadow-[0_-4px_20px_rgba(0,0,0,0.05)] rounded-t-2xl">
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <Link key={item.name} href={item.href} className="flex flex-col items-center gap-1 group w-16">
            <div className={`p-2 rounded-xl transition-all duration-300 ease-out ${isActive ? "bg-primary/10 text-primary scale-110" : "text-gray-400 group-hover:text-gray-600 group-hover:bg-gray-50"}`}>
              <item.icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
            </div>
            <span className={`text-[10px] font-medium transition-colors ${isActive ? "text-primary" : "text-gray-400"}`}>
              {item.name}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
