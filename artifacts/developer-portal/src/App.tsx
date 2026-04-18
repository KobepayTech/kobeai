import { Switch, Route, Router as WouterRouter, useLocation, Redirect, Link } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import DashboardPage from "@/pages/dashboard";
import NewAppPage from "@/pages/new-app";
import BillingPage from "@/pages/billing";
import EarningsPage from "@/pages/earnings";
import AdsAdminPage from "@/pages/ads-admin";

const queryClient = new QueryClient();

function Protected({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Redirect to="/login" />;
  return <>{children}</>;
}

function Header() {
  const { developer, logout, isAuthenticated } = useAuth();
  const [location] = useLocation();

  if (!isAuthenticated) return null;

  const link = (to: string, label: string) => (
    <Link
      href={to}
      className={`px-3 py-1.5 rounded-md text-sm font-medium ${
        location === to
          ? "bg-[#00A86B] text-white"
          : "text-white/80 hover:text-white hover:bg-white/10"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header style={{ background: "#1A1A2E" }} className="text-white">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="font-bold text-lg">
            Kobe<span style={{ color: "#00A86B" }}>AI</span> Developers
          </Link>
          <nav className="flex gap-1 ml-6">
            {link("/dashboard", "My Apps")}
            {link("/earnings", "Earnings")}
            {link("/billing", "Plan")}
            {link("/ads-admin", "Ads Admin")}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-white/70 hidden sm:inline">
            {developer?.display_name} · {developer?.plan}
          </span>
          <button onClick={logout} className="text-sm text-white/80 hover:text-white">
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function Routes() {
  return (
    <>
      <Header />
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/signup" component={SignupPage} />
        <Route path="/dashboard">
          <Protected><DashboardPage /></Protected>
        </Route>
        <Route path="/apps/new">
          <Protected><NewAppPage /></Protected>
        </Route>
        <Route path="/billing">
          <Protected><BillingPage /></Protected>
        </Route>
        <Route path="/earnings">
          <Protected><EarningsPage /></Protected>
        </Route>
        <Route path="/ads-admin" component={AdsAdminPage} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AuthProvider>
          <Routes />
        </AuthProvider>
      </WouterRouter>
    </QueryClientProvider>
  );
}
