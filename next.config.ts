import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev server listens on 0.0.0.0:3000. Let other machines on the network load dev assets too: any IPv4 address
  // (e.g. http://10.10.3.3:3000) or a .local name. Fine on a private network; production (next start) needs no entry.
  allowedDevOrigins: ["*.*.*.*", "*.local"],
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
