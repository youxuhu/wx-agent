import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The UI is served by our own Node service (server/main.ts) from `dist/`,
 * so the build output is a plain static bundle with relative asset paths.
 */
export default defineConfig({
	root: resolve(here, "web"),
	base: "./",
	plugins: [vue()],
	build: {
		outDir: resolve(here, "dist"),
		emptyOutDir: true,
		// Pixelium ships a font (woff2) and icon css; keep them as real files.
		assetsInlineLimit: 0,
		chunkSizeWarningLimit: 1500,
	},
});
