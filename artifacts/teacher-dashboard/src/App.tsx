import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { Shell } from "@/components/layout/shell";

// Pages
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Students from "@/pages/students";
import Attendance from "@/pages/attendance";
import Quizzes from "@/pages/quizzes";
import Bursar from "@/pages/bursar";
import Documents from "@/pages/documents";
import SchoolAi from "@/pages/school-ai";
import CentralTenants from "@/pages/central-tenants";
import CentralTenantDetail from "@/pages/central-tenant-detail";

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
      <Route path="/login" component={Login} />
      
      {/* Protected Routes wrapped in Shell */}
      <Route path="/dashboard">
        <Shell><Dashboard /></Shell>
      </Route>
      <Route path="/students">
        <Shell><Students /></Shell>
      </Route>
      <Route path="/attendance">
        <Shell><Attendance /></Shell>
      </Route>
      <Route path="/quizzes">
        <Shell><Quizzes /></Shell>
      </Route>
      <Route path="/bursar">
        <Shell><Bursar /></Shell>
      </Route>
      <Route path="/documents">
        <Shell><Documents /></Shell>
      </Route>
      <Route path="/school-ai">
        <Shell><SchoolAi /></Shell>
      </Route>
      <Route path="/central">
        <Shell><CentralTenants /></Shell>
      </Route>
      <Route path="/central/:id">
        <Shell><CentralTenantDetail /></Shell>
      </Route>

      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
