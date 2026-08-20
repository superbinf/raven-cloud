import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.SENTINEL_CLOUD_DEV_URL ?? "http://127.0.0.1:8787",
        changeOrigin: true
      },
      "/edge": {
        target: process.env.SENTINEL_CLOUD_DEV_URL ?? "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        admin: resolve(__dirname, "index.html"),
        tenantPortal: resolve(__dirname, "tenant-portal.html")
      },
      output: {
        manualChunks(id) {
          if (id.includes("echarts")) return "charts";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "editor";
          if (id.includes("react") || id.includes("react-router")) return "react-vendor";
        }
      }
    }
  }
});
