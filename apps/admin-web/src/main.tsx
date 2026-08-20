import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@/assets/styles/globals.css";
import "@sentinel/ui/styles.css";
import "@/assets/styles/admin.css";
import "@/assets/styles/changan-theme.css";
import { AdminApp } from "@/App";
import { GlobalErrorBoundary, initializeUiTheme } from "@/components/common";

initializeUiTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalErrorBoundary homePath="/admin" homeLabel="返回管理首页">
      <BrowserRouter>
        <AdminApp />
      </BrowserRouter>
    </GlobalErrorBoundary>
  </StrictMode>
);
