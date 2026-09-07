import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const backendPort = process.env.PORT || "8080";
const backendOrigin = `http://127.0.0.1:${backendPort}`;

function configureLoopbackProxy(proxy) {
  const rewriteSafeDevOrigin = (proxyRequest, request) => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (typeof origin !== "string" || typeof host !== "string") return;
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
      const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
      if (
        isLoopback &&
        parsed.protocol === "http:" &&
        parsed.origin === origin &&
        parsed.host.toLowerCase() === host.toLowerCase()
      ) {
        proxyRequest.setHeader("origin", backendOrigin);
      }
    } catch {
      // Preserve malformed or cross-origin values so the backend rejects them.
    }
  };
  proxy.on("proxyReq", rewriteSafeDevOrigin);
  proxy.on("proxyReqWs", rewriteSafeDevOrigin);
}

export default defineConfig(({ mode }) => ({
  // Chrome 109 is the last version that runs on Windows 7/8.1, so it is the floor
  // for the hosted lane. Anything newer would ship syntax the target cannot parse.
  build: {
    target: ["chrome109", "edge109", "firefox115", "safari15.6"],
    cssTarget: "chrome109"
  },
  esbuild: {
    target: "chrome109"
  },
  plugins: [
    react(),
    ...(mode === "locallane" ? [VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/karaoke-station.svg", "icons/karaoke-station-256.png", "icons/karaoke-station-512.png"],
      manifest: {
        name: "KaraokeStation",
        short_name: "Karaoke",
        description: "Local-first karaoke queue and party remote.",
        theme_color: "#101317",
        background_color: "#101317",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/icons/karaoke-station-256.png",
            sizes: "256x256",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/icons/karaoke-station-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "/icons/karaoke-station.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/i\.ytimg\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "youtube-thumbnails",
              expiration: { maxEntries: 100, maxAgeSeconds: 86400 }
            }
          }
        ]
      }
    })] : [])
  ],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: backendOrigin,
        changeOrigin: true,
        configure: configureLoopbackProxy
      },
      "/socket.io": {
        target: `ws://127.0.0.1:${backendPort}`,
        changeOrigin: true,
        configure: configureLoopbackProxy,
        ws: true
      }
    }
  }
}));
