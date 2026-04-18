import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import Dashboard from "@/pages/Dashboard";
import NewCampaign from "@/pages/NewCampaign";
import Creatives from "@/pages/Creatives";
import Stats from "@/pages/Stats";
import Wallet from "@/pages/Wallet";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

function Protected({ children }: { children: React.ReactNode }) {
  const { advertiser, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted">Loading…</div>
    );
  }
  if (!advertiser) return <Redirect to="/login" />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { advertiser, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted">Loading…</div>
    );
  }
  if (advertiser) return <Redirect to="/dashboard" />;
  return <>{children}</>;
}

function Routes() {
  return (
    <Switch>
      <Route path="/">{() => <Redirect to="/dashboard" />}</Route>
      <Route path="/login">
        <PublicOnly>
          <Login />
        </PublicOnly>
      </Route>
      <Route path="/signup">
        <PublicOnly>
          <Signup />
        </PublicOnly>
      </Route>
      <Route path="/dashboard">
        <Protected>
          <Dashboard />
        </Protected>
      </Route>
      <Route path="/campaigns/new">
        <Protected>
          <NewCampaign />
        </Protected>
      </Route>
      <Route path="/campaigns/:id/creatives">
        <Protected>
          <Creatives />
        </Protected>
      </Route>
      <Route path="/stats">
        <Protected>
          <Stats />
        </Protected>
      </Route>
      <Route path="/wallet">
        <Protected>
          <Wallet />
        </Protected>
      </Route>
      <Route>{() => <Redirect to="/dashboard" />}</Route>
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Routes />
        </WouterRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
