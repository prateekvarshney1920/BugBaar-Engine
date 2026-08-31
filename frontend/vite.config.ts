import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ENGINE_URL = process.env.ENGINE_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy to the engine so the browser makes same-origin requests and the
    // dashboard never has to care about the gateway's CORS configuration.
    proxy: {
      "/v1": { target: ENGINE_URL, changeOrigin: true },
      "/health": { target: ENGINE_URL, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
