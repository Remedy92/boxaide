import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The CLI package at the repo root keeps its own lockfile, so Turbopack would
  // otherwise infer the repo root as the workspace root and warn on every
  // build. apps/web installs alone — on Vercel via the Root Directory setting,
  // locally via its own package-lock.json.
  turbopack: { root: import.meta.dirname },
  // babel-plugin-react-compiler is a devDependency; without this flag it was
  // installed and never run, which made the hand-memoisation in this codebase
  // look load-bearing when nothing was enforcing it.
  reactCompiler: true,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
