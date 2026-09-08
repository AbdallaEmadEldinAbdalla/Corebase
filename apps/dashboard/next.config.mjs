/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is a pure client of the platform API (D-130): no API routes,
  // no server-side data fetching against the control plane, no BFF. If something
  // here ever needs a backend, the answer is a platform API endpoint — which the
  // CLI then gets for free.
  reactStrictMode: true,
  // The API base is read at *runtime* from the browser, not baked in at build
  // time, so one image can serve staging and production. See src/lib/api.ts.
  // @steadhold/types ships TypeScript source (main points at src/index.ts), which
  // is the right call for a workspace package Node runs with type stripping — and
  // it means Next has to compile it rather than treat it as a built dependency.
  transpilePackages: ['@steadhold/types'],
};
export default nextConfig;
