import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Environment variables (VITE_*) are read from the repository-root .env, shared with backend/contracts.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "VITE_");
  const api = env.VITE_API_URL || "http://localhost:4000";
  return {
    plugins: [react(), tailwindcss()],
    envDir: repoRoot,
    server: {
      port: 5173,
      proxy: {
        // same-origin API calls in development; production builds call VITE_API_URL directly
        "/api": { target: api, changeOrigin: true },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      rollupOptions: {
        output: {
          // long-lived vendor chunks: app releases don't invalidate the cached libraries.
          // vendor-react must hold exactly react, react-dom and scheduler: those three import nothing
          // else, so the chunk has no imports and React's CommonJS body runs before anything that
          // needs it. Matching loosely (e.g. "/react") pulled react-stately, react-transition-group
          // and @radix-ui/react-* in, created an import cycle between the vendor chunks, and the
          // production bundle died on load with "Cannot set properties of undefined (setting 'Activity')".
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
            if (id.includes("ethers") || id.includes("@noble") || id.includes("@adraffy")) return "vendor-ethers";
            if (id.includes("@heroui") || id.includes("react-aria") || id.includes("react-stately") || id.includes("@react-types") || id.includes("@internationalized")) return "vendor-ui";
            return "vendor";
          },
        },
      },
    },
  };
});
