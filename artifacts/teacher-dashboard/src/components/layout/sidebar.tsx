import { useAuth } from "@/lib/auth";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Users, 
  CalendarCheck, 
  BookOpenCheck, 
  Wallet,
  FileText,
  Cpu,
  Building2,
  LogOut,
  School,
  CalendarClock,
  Timer,
  Target,
  Coins,
  Share2,
  Package,
  KeyRound,
  Boxes,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/students", label: "Students", icon: Users },
  { href: "/attendance", label: "Attendance", icon: CalendarCheck },
  { href: "/quizzes", label: "Quizzes", icon: BookOpenCheck },
  { href: "/timetable", label: "Timetable", icon: CalendarClock },
  { href: "/exams", label: "Exam Mode", icon: Timer },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/bursar", label: "Bursar", icon: Wallet },
  { href: "/stationery", label: "Stationery", icon: Package },
  { href: "/claim-codes", label: "Claim Codes", icon: KeyRound },
  { href: "/school-ai", label: "School AI", icon: Cpu },
  { href: "/central", label: "Central Admin", icon: Building2 },
  { href: "/central-market", label: "Question Market", icon: Target },
  { href: "/central-stationery", label: "Central Stationery", icon: Boxes },
  { href: "/central-kp", label: "KP Ledger", icon: Coins },
  { href: "/parent-install", label: "Parent Install Link", icon: Share2 },
];

export function Sidebar() {
  const [location] = useLocation();
  const { logout } = useAuth();

  return (
    <aside className="fixed inset-y-0 left-0 w-64 bg-sidebar border-r border-sidebar-border flex flex-col z-20">
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border bg-sidebar">
        <School className="h-6 w-6 text-primary mr-2" />
        <span className="font-bold text-lg text-sidebar-foreground tracking-tight">KobeAI</span>
      </div>

      <nav className="flex-1 overflow-y-auto py-6 px-4 space-y-1">
        {navItems.map((item) => {
          const isActive = location === item.href || location.startsWith(`${item.href}/`);
          const Icon = item.icon;
          
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-sidebar-border">
        <Button 
          variant="ghost" 
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={logout}
        >
          <LogOut className="h-5 w-5 mr-3" />
          Logout
        </Button>
      </div>
    </aside>
  );
}
