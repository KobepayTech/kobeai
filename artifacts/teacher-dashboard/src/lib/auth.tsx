import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useLocation } from "wouter";

interface AuthContextType {
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem("teacher_token");
  });
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (token) {
      localStorage.setItem("teacher_token", token);
    } else {
      localStorage.removeItem("teacher_token");
    }
  }, [token]);

  const login = (newToken: string) => {
    setToken(newToken);
    setLocation("/dashboard");
  };

  const logout = () => {
    setToken(null);
    setLocation("/login");
  };

  return (
    <AuthContext.Provider value={{ token, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
