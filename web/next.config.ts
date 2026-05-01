import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Repo root has another package-lock.json; pin Turbopack workspace root to `web/` (local + Vercel).
  turbopack: {
    root: path.join(__dirname),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "partselectcom-gtcdcddbene3cpes.z01.azurefd.net",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
