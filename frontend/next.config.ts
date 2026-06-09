import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/run",
        destination: "http://localhost:8001/run",
      },
      {
        source: "/results/:path*",
        destination: "http://localhost:8001/results/:path*",
      },
      {
        source: "/runs/:path*",
        destination: "http://localhost:8001/runs/:path*",
      },
    ];
  },
};

export default nextConfig;
