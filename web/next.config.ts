import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
