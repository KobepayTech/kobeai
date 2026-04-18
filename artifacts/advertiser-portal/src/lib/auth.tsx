import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { apiGet } from "./api";

export interface Advertiser {
  id: number;
  company_name: string;
  contact_email: string;
  balance_tsh: number;
  status: string;
}

interface AuthCtx {
  advertiser: Advertiser | null;
  loading: boolean;
  setToken: (token: string) => void;
  refresh: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [advertiser, setAdvertiser] = useState<Advertiser | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const token = localStorage.getItem("adv_token");
    if (!token) {
      setAdvertiser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await apiGet<{ advertiser: Advertiser }>("/v1/advertiser/me");
      setAdvertiser(me.advertiser);
    } catch {
      localStorage.removeItem("adv_token");
      setAdvertiser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function setToken(token: string) {
    localStorage.setItem("adv_token", token);
    setLoading(true);
    refresh();
  }

  function logout() {
    localStorage.removeItem("adv_token");
    setAdvertiser(null);
  }

  return (
    <Ctx.Provider value={{ advertiser, loading, setToken, refresh, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
