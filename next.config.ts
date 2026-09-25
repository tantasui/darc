import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray package-lock.json above this directory otherwise makes
  // Turbopack guess, and it warns about it.
  turbopack: { root: import.meta.dirname },
  // contracts/ is a Foundry project, not part of the web build.
  outputFileTracingExcludes: { "*": ["./contracts/**"] },
};

export default nextConfig;
