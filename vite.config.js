import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["apple-touch-icon.png"],
      workbox: {
        // Precache the whole app shell, including the ~1.4 MB pdf.js worker.
        globPatterns: ["**/*.{js,mjs,css,html,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: "mreader",
        short_name: "mreader",
        description: "A minimal reader for EPUB & PDF",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#1a1815",
        theme_color: "#1a1815",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
