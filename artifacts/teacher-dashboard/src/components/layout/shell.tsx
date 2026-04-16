import { ReactNode, useEffect } from "react";
import { Sidebar } from "./sidebar";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";

export function Shell({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isAuthenticated) {
      setLocation("/login");
    }
  }, [isAuthenticated, setLocation]);

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-64 min-h-screen flex flex-col">
        <div className="flex-1 p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
