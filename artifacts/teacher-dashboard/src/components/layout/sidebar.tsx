import { useAuth } from "@/lib/auth";
import { useMe, type CapabilityKey } from "@/lib/capabilities";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  CalendarCheck,
  Camera,
  CircleAlert,
  MessagesSquare,
  HardDrive,
  Lightbulb,
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
  ShieldCheck,
  Receipt,
  Trophy,
  QrCode,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// Each item declares the capability it needs. The server answers
// /v1/me/capabilities; a teacher no longer sees "Central Admin" sitting in
// the sidebar taunting them with a 403, and a school administrator never
// learns the operator console exists at all.
type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  needs: CapabilityKey;
};

const SCHOOL_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, needs: "teaching" },
  { href: "/students", label: "Students", icon: Users, needs: "teaching" },
  { href: "/attendance", label: "Attendance", icon: CalendarCheck, needs: "teaching" },
  { href: "/attendance-exceptions", label: "Attendance Exceptions", icon: CircleAlert, needs: "teaching" },
  { href: "/classroom-insights", label: "Classroom Insights", icon: MessagesSquare, needs: "teaching" },
  { href: "/student-development", label: "Student Development", icon: Lightbulb, needs: "teaching" },
  { href: "/camera-network", label: "Camera Network", icon: Camera, needs: "teaching" },
  { href: "/quizzes", label: "Quizzes", icon: BookOpenCheck, needs: "teaching" },
  { href: "/timetable", label: "Timetable", icon: CalendarClock, needs: "teaching" },
  { href: "/exams", label: "Exam Mode", icon: Timer, needs: "teaching" },
  { href: "/results", label: "Results", icon: Trophy, needs: "teaching" },
  { href: "/documents", label: "Documents", icon: FileText, needs: "teaching" },
  { href: "/onboarding", label: "Staff & Students", icon: QrCode, needs: "onboarding" },
  { href: "/bursar", label: "Bursar", icon: Wallet, needs: "bursar" },
  { href: "/stationery", label: "Stationery", icon: Package, needs: "teaching" },
  { href: "/claim-codes", label: "Claim Codes", icon: KeyRound, needs: "teaching" },
  { href: "/school-ai", label: "School AI", icon: Cpu, needs: "school_settings" },
  { href: "/models", label: "K9 Models", icon: HardDrive, needs: "school_settings" },
  { href: "/parent-install", label: "Parent Install Link", icon: Share2, needs: "teaching" },
];

const OPERATOR_NAV: NavItem[] = [
  { href: "/central", label: "Schools", icon: Building2, needs: "tenants" },
  { href: "/market-agent", label: "Market Agent", icon: Bot, needs: "market_agent" },
  { href: "/central-market", label: "Question Market", icon: Target, needs: "market_agent" },
  { href: "/central-kp", label: "KP Ledger", icon: Coins, needs: "kp_economy" },
  { href: "/central-stationery", label: "Central Stationery", icon: Boxes, needs: "central_stationery" },
  { href: "/moderation-apps", label: "App Moderation", icon: ShieldCheck, needs: "moderation" },
  { href: "/moderation-payments", label: "Dev Payments", icon: Receipt, needs: "moderation" },
];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link href={item.href}>
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
          active
            ? "bg-primary text-primary-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className="h-5 w-5" />
        {item.label}
      </div>
    </Link>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const { logout } = useAuth();
  const { me, can } = useMe();

  const isActive = (href: string) => location === href || location.startsWith(`${href}/`);
  const school = SCHOOL_NAV.filter((item) => can[item.needs]);
  const operator = OPERATOR_NAV.filter((item) => can[item.needs]);

  return (
    <aside className="print:hidden fixed inset-y-0 left-0 w-64 bg-sidebar border-r border-sidebar-border flex flex-col z-20">
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border bg-sidebar">
        <School className="h-6 w-6 text-primary mr-2" />
        <div className="min-w-0">
          <div className="font-bold text-lg text-sidebar-foreground tracking-tight leading-none">KobeAI</div>
          {me?.school_name && (
            <div className="text-xs text-muted-foreground truncate">{me.school_name}</div>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-6 px-4 space-y-1">
        {school.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}

        {operator.length > 0 && (
          <>
            <div className="pt-6 pb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Operator
            </div>
            {operator.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} />
            ))}
          </>
        )}
      </nav>

      <div className="p-4 border-t border-sidebar-border">
        {me?.name && (
          <div className="px-3 pb-2 text-xs text-muted-foreground truncate">
            {me.name} · {me.role.replace("_", " ")}
          </div>
        )}
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
