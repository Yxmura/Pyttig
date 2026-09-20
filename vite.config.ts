import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Keep workers as separate chunks for clarity; Vite handles ?worker suffixes.
        manualChunks: undefined,
      },
    },
  },
  server: {
    headers: {
      // Cross-origin isolation enables SharedArrayBuffer:
      // hard stop (SIGINT), interactive input(), streaming requests.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  worker: {
    format: "es",
  },
});
