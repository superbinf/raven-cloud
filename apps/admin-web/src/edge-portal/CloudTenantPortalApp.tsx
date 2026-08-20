import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { EdgePortalModule } from "@sentinel/contracts";
import { PlatformLoading } from "@/components/common";
import { PortalLayout, readPortalSession } from "./app/PortalShell";
import { moduleConfigs, sensitiveCategoryBySubtype, type ModuleConfig } from "./config/modules";

const HtmlAssetReportPage = lazy(() => import("./pages/AssetReportPage").then((module) => ({ default: module.HtmlAssetReportPage })));
const CredentialLeakPage = lazy(() => import("./pages/CredentialLeakPage").then((module) => ({ default: module.CredentialLeakPage })));
const DarkWebEventDetailPage = lazy(() => import("./pages/DarkWebEventDetailPage").then((module) => ({ default: module.DarkWebEventDetailPage })));
const IntelligenceDetail = lazy(() => import("./pages/IntelligenceDetail").then((module) => ({ default: module.IntelligenceDetail })));
const ModulePage = lazy(() => import("./pages/ModulePage").then((module) => ({ default: module.ModulePage })));
const PortalHome = lazy(() => import("./pages/PortalHome").then((module) => ({ default: module.PortalHome })));
const SearchPage = lazy(() => import("./pages/SearchPage").then((module) => ({ default: module.SearchPage })));
const SensitiveDataPage = lazy(() => import("./pages/SensitiveDataPage").then((module) => ({ default: module.SensitiveDataPage })));
const SituationDashboard = lazy(() => import("./pages/SituationDashboard").then((module) => ({ default: module.SituationDashboard })));
const vulnerabilityPages = () => import("./pages/VulnerabilityIntelligencePage");
const AssetVulnerabilityAlertsPage = lazy(() => vulnerabilityPages().then((module) => ({ default: module.AssetVulnerabilityAlertsPage })));
const MajorEventVulnerabilityPage = lazy(() => vulnerabilityPages().then((module) => ({ default: module.MajorEventVulnerabilityPage })));
const VulnerabilityInventoryPage = lazy(() => vulnerabilityPages().then((module) => ({ default: module.VulnerabilityInventoryPage })));

const enabledModules: EdgePortalModule[] = ["overview", "dashboard", "search", "dark-web", "sensitive", "exposure", "vulnerabilities"];

function modulePageElement(config: ModuleConfig) {
  if (config.subtype === "资产监测") return <HtmlAssetReportPage config={config} />;
  if (sensitiveCategoryBySubtype[config.subtype]) return <SensitiveDataPage config={config} />;
  return <ModulePage config={config} />;
}

export function CloudTenantPortalApp() {
  const session = readPortalSession();
  if (!session) {
    window.top?.location.assign("/admin/login");
    return null;
  }

  return <Suspense fallback={<PlatformLoading />}><Routes>
    <Route path="/portal/dashboard" element={<SituationDashboard />} />
    <Route path="/portal" element={<PortalLayout session={session} enabledModules={enabledModules} />}>
      <Route index element={<PortalHome enabledModules={enabledModules} />} />
      <Route path="modules/dark-web/credential-leaks" element={<CredentialLeakPage />} />
      <Route path="modules/dark-web/data-leakage" element={<Navigate to="/portal/modules/dark-web/intelligence" replace />} />
      <Route path="modules/vulnerabilities/all" element={<VulnerabilityInventoryPage />} />
      <Route path="modules/vulnerabilities/major-event" element={<MajorEventVulnerabilityPage />} />
      <Route path="modules/vulnerabilities/asset-alerts" element={<AssetVulnerabilityAlertsPage />} />
      {moduleConfigs.filter((config) => config.subtype !== "凭据泄露").map((config) => (
        <Route key={config.path} path={config.path.replace("/portal/", "")} element={modulePageElement(config)} />
      ))}
      <Route path="search" element={<SearchPage enabledModules={enabledModules} />} />
      <Route path="dark-web/events/:id" element={<DarkWebEventDetailPage />} />
      <Route path="intelligence/:id" element={<IntelligenceDetail />} />
    </Route>
    <Route path="/" element={<Navigate to="/portal" replace />} />
    <Route path="*" element={<Navigate to="/portal" replace />} />
  </Routes></Suspense>;
}
