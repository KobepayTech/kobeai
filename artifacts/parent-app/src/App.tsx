import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Wallet from "@/pages/wallet";
import Activity from "@/pages/activity";
import Profile from "@/pages/profile";
import PrintPage from "@/pages/print";
import PrintHistoryPage from "@/pages/print-history";
import SubscriptionPage from "@/pages/subscription";
import WatchSettings from "@/pages/watch-settings";
import NotificationsPage from "@/pages/notifications";
import AddChildPage from "@/pages/add-child";
import StationeryPage from "@/pages/stationery";
import { InstallPrompt } from "@/components/install-prompt";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Redirect to="/dashboard" />} />
      <Route path="/login" component={Login} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/activity" component={Activity} />
      <Route path="/print" component={PrintPage} />
      <Route path="/print/history" component={PrintHistoryPage} />
      <Route path="/subscription" component={SubscriptionPage} />
      <Route path="/profile" component={Profile} />
      <Route path="/profile/watch" component={WatchSettings} />
      <Route path="/profile/notifications" component={NotificationsPage} />
      <Route path="/add-child" component={AddChildPage} />
      <Route path="/stationery" component={StationeryPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
          <InstallPrompt />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
