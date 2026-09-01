import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    watch: { usePolling: true, interval: 800 },
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
