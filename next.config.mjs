/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["postgres"],
  output: "standalone", // self-contained server.js for a small Docker image (Fly)
};

export default nextConfig;
