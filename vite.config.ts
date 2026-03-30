import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: true,
  },
});
