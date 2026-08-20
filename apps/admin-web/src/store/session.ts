import { create } from "zustand";

import type { AdminSession } from "@/types";

export const adminSessionKey = "sentinel.admin.session";

export function readAdminSession(): AdminSession | null {
  try {
    const value = window.sessionStorage.getItem(adminSessionKey);
    if (!value) return null;
    const session = JSON.parse(value) as AdminSession;
    if (!session.token || new Date(session.expiresAt).getTime() <= Date.now() || !["admin", "both"].includes(session.user.workspace) || !Array.isArray(session.user.permissions)) {
      window.sessionStorage.removeItem(adminSessionKey);
      return null;
    }
    return session;
  } catch {
    window.sessionStorage.removeItem(adminSessionKey);
    return null;
  }
}

type AdminSessionState = {
  session: AdminSession | null;
  setSession: (session: AdminSession) => void;
  clearSession: () => void;
};

export const useAdminSessionStore = create<AdminSessionState>((set) => ({
  session: readAdminSession(),
  setSession: (session) => {
    window.sessionStorage.setItem(adminSessionKey, JSON.stringify(session));
    set({ session });
  },
  clearSession: () => {
    window.sessionStorage.removeItem(adminSessionKey);
    set({ session: null });
  }
}));
