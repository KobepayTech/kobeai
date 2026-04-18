import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useLocation } from "wouter";

export interface DeveloperProfile {
  id: number;
  email: string;
  display_name: string;
  bio?: string | null;
  website?: string | null;
  plan: "none" | "indie" | "studio" | string;
  plan_status: "inactive" | "pending_payment" | "active" | "expired" | string;
  plan_expires_at?: string | null;
  payout_method?: string | null;
  payout_account?: string | null;
  total_published_apps: number;
  total_installs: number;
  total_earnings_tsh: number;
  total_earnings_kp: number;
  unpaid_balance_tsh: number;
  unpaid_balance_kp: number;
  banned: boolean;
  created_at: string;
}

interface AuthContextType {
  token: string | null;
  developer: DeveloperProfile | null;
  login: (token: string, dev: DeveloperProfile) => void;
  logout: () => void;
  setDeveloper: (d: DeveloperProfile) => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem("dev_token"),
  );
  const [developer, setDeveloperState] = useState<DeveloperProfile | null>(() => {
    const raw = localStorage.getItem("dev_profile");
    return raw ? JSON.parse(raw) : null;
  });
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (token) localStorage.setItem("dev_token", token);
    else localStorage.removeItem("dev_token");
  }, [token]);

  useEffect(() => {
    if (developer) localStorage.setItem("dev_profile", JSON.stringify(developer));
    else localStorage.removeItem("dev_profile");
  }, [developer]);

  const login = (newToken: string, dev: DeveloperProfile) => {
    setToken(newToken);
    setDeveloperState(dev);
    setLocation("/dashboard");
  };

  const logout = () => {
    setToken(null);
    setDeveloperState(null);
    setLocation("/login");
  };

  return (
    <AuthContext.Provider
      value={{
        token,
        developer,
        login,
        logout,
        setDeveloper: setDeveloperState,
        isAuthenticated: !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
