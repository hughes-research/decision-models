import type { NextConfig } from "next";
import os from "node:os";

// `npm run dev` listens on 127.0.0.1 only. The dev server exposes developer endpoints (open files in the editor, source
// maps with home-directory paths), so it should not face a network. `npm run dev:lan` opens it to the LAN for trusted
// networks; then this machine's own addresses and .local name may load dev assets, with no wildcard (a "*.*.*.*" entry
// would match ANY four-label domain). For an audience or shared Wi-Fi, use `npm run demo`: a production build on
// 0.0.0.0:3000 with no dev endpoints and no source maps.
const lanOrigins = [
  ...Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address),
  `${os.hostname().replace(/\.local$/, "")}.local`,
];

const nextConfig: NextConfig = {
  allowedDevOrigins: lanOrigins,
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
