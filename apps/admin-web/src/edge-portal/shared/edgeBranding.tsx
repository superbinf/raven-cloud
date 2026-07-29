import { useEffect, useState } from "react";
import { cn } from "@sentinel/ui";
import { cloudPortalTenantChangedEvent, portalApiFetch } from "./api/portalApi";

const trimmedLogoCache = new Map<string, Promise<string>>();

function trimTransparentLogo(source: string): Promise<string> {
  const cached = trimmedLogoCache.get(source);
  if (cached) return cached;

  const result = new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context || !canvas.width || !canvas.height) {
          resolve(source);
          return;
        }

        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let left = canvas.width;
        let top = canvas.height;
        let right = -1;
        let bottom = -1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            if (pixels[(y * canvas.width + x) * 4 + 3] < 8) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }

        if (right < left || bottom < top) {
          resolve(source);
          return;
        }

        const visibleWidth = right - left + 1;
        const visibleHeight = bottom - top + 1;
        const padding = Math.max(2, Math.round(visibleHeight * 0.08));
        const cropLeft = Math.max(0, left - padding);
        const cropTop = Math.max(0, top - padding);
        const cropRight = Math.min(canvas.width, right + padding + 1);
        const cropBottom = Math.min(canvas.height, bottom + padding + 1);

        if (cropRight - cropLeft === canvas.width && cropBottom - cropTop === canvas.height) {
          resolve(source);
          return;
        }

        const trimmedCanvas = document.createElement("canvas");
        trimmedCanvas.width = cropRight - cropLeft;
        trimmedCanvas.height = cropBottom - cropTop;
        const trimmedContext = trimmedCanvas.getContext("2d");
        if (!trimmedContext) {
          resolve(source);
          return;
        }
        trimmedContext.drawImage(canvas, cropLeft, cropTop, trimmedCanvas.width, trimmedCanvas.height, 0, 0, trimmedCanvas.width, trimmedCanvas.height);
        resolve(trimmedCanvas.toDataURL("image/png"));
      } catch {
        resolve(source);
      }
    };
    image.onerror = () => resolve(source);
    image.src = source;
  });

  trimmedLogoCache.set(source, result);
  return result;
}

export type EdgeBranding = {
  name: string;
  logoUrl: string;
  loginTitle: string;
  loginSlogan: string;
  loginDescription: string;
};

export const defaultEdgeBranding: EdgeBranding = {
  name: "威胁情报中心",
  logoUrl: "",
  loginTitle: "登录情报前台",
  loginSlogan: "科技长安 智慧伙伴",
  loginDescription: ""
};

function normalizeBranding(value?: Partial<EdgeBranding>): EdgeBranding {
  return {
    name: value?.name?.trim() || defaultEdgeBranding.name,
    logoUrl: value?.logoUrl?.trim() || "",
    loginTitle: value?.loginTitle?.trim() || defaultEdgeBranding.loginTitle,
    loginSlogan: value?.loginSlogan === undefined ? defaultEdgeBranding.loginSlogan : value.loginSlogan.trim(),
    loginDescription: value?.loginDescription === undefined ? defaultEdgeBranding.loginDescription : value.loginDescription.trim()
  };
}

export function useEdgeBranding() {
  const [branding, setBranding] = useState<EdgeBranding>(defaultEdgeBranding);
  useEffect(() => {
    let active = true;
    let requestId = 0;
    const loadBranding = () => {
      const currentRequestId = ++requestId;
      void portalApiFetch<Partial<EdgeBranding>>("/api/edge-admin/branding")
        .then((value) => {
          if (active && currentRequestId === requestId) setBranding(normalizeBranding(value));
        })
        .catch(() => undefined);
    };
    loadBranding();
    window.addEventListener(cloudPortalTenantChangedEvent, loadBranding);
    return () => {
      active = false;
      window.removeEventListener(cloudPortalTenantChangedEvent, loadBranding);
    };
  }, []);
  useEffect(() => { document.title = `Sentinel ${branding.name}`; }, [branding.name]);
  return branding;
}

export function EdgeBrandLogo({ branding, className, fallbackClassName }: { branding: Pick<EdgeBranding, "name" | "logoUrl">; className?: string; fallbackClassName?: string }) {
  const [failedUrl, setFailedUrl] = useState("");
  const [displayUrl, setDisplayUrl] = useState(branding.logoUrl);
  useEffect(() => {
    let active = true;
    setDisplayUrl(branding.logoUrl);
    if (branding.logoUrl.startsWith("data:image/")) {
      void trimTransparentLogo(branding.logoUrl).then((trimmedUrl) => {
        if (active) setDisplayUrl(trimmedUrl);
      });
    }
    return () => { active = false; };
  }, [branding.logoUrl]);
  if (branding.logoUrl && failedUrl !== branding.logoUrl) {
    return <span className={cn("edge-brand-logo", className)}><img src={displayUrl} alt={`${branding.name} Logo`} onError={() => setFailedUrl(branding.logoUrl)} /></span>;
  }
  return <span className={cn("edge-brand-name", fallbackClassName || className)}>{branding.name}</span>;
}
