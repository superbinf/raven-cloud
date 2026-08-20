import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PlatformLoading } from "@/components/common";

type LoadingReporter = (key: string, loading: boolean) => void;

const AdminInitialLoadingContext = createContext<LoadingReporter>(() => undefined);

export function AdminInitialLoadingProvider({ children }: { children: ReactNode }) {
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set());
  const report = useCallback<LoadingReporter>((key, loading) => {
    setLoadingKeys((current) => {
      if (current.has(key) === loading) return current;
      const next = new Set(current);
      if (loading) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  return <>
    <AdminInitialLoadingContext.Provider value={report}>{children}</AdminInitialLoadingContext.Provider>
    {loadingKeys.size > 0 && <div className="admin-initial-loading-overlay"><PlatformLoading /></div>}
  </>;
}

export function useAdminInitialLoading(key: string, loading: boolean) {
  const report = useContext(AdminInitialLoadingContext);
  const settled = useRef(!loading);
  if (!loading) settled.current = true;
  const initialLoading = loading && !settled.current;

  useLayoutEffect(() => {
    report(key, initialLoading);
    return () => report(key, false);
  }, [initialLoading, key, report]);
}
