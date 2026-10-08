import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: path.resolve(__dirname, "../../..") },
  typescript: { ignoreBuildErrors: true },
};

export default config;
