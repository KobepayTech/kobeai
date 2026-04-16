import { create } from "zustand";

interface AuthState {
  token: string | null;
  setToken: (token: string | null) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem("parent_token"),
  setToken: (token) => {
    if (token) {
      localStorage.setItem("parent_token", token);
    } else {
      localStorage.removeItem("parent_token");
    }
    set({ token });
  },
  logout: () => {
    localStorage.removeItem("parent_token");
    set({ token: null });
  },
}));
