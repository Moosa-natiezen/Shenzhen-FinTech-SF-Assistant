/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The backend (Hono gateway) is a separate process; the portal talks to it
  // over NEXT_PUBLIC_API_BASE with credentialed fetch (Better Auth cookies).
  // TS 7 removed `baseUrl`, so tsc resolves "@/x" via tsconfig `paths` alone —
  // the bundler needs the equivalent alias spelled out explicitly.
  turbopack: {
    resolveAlias: { "@": "./src" },
  },
};
export default nextConfig;
