import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { GlobalErrorBoundary, initializeUiTheme } from "@/components/common";
import "@/assets/styles/globals.css";
import "@sentinel/ui/styles.css";
import "./portal.css";
import "./changan-theme.css";
import { CloudTenantPortalApp } from "./CloudTenantPortalApp";

initializeUiTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalErrorBoundary homePath="/portal" homeLabel="返回情报首页">
      <HashRouter>
        <CloudTenantPortalApp />
      </HashRouter>
    </GlobalErrorBoundary>
  </StrictMode>
);
