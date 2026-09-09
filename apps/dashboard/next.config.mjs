/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is a pure client of the platform API (D-130): no API routes,
  // no server-side data fetching against the control plane, no BFF. If something
  // here ever needs a backend, the answer is a platform API endpoint — which the
  // CLI then gets for free.
  reactStrictMode: true,
  // The API base is read at *runtime* from the browser, not baked in at build
  // time, so one image can serve staging and production. See src/lib/api.ts.
  // @steadhold/types and @steadhold/sql-guard ship TypeScript source (main points
  // at src/index.ts), which is the right call for a workspace package Node runs
  // with type stripping — and it means Next has to compile them rather than treat
  // them as built dependencies.
  //
  // sql-guard is here because D-134 makes the dashboard's copy of the guard the
  // *same code* as the server's rather than a mirror of it. A mirror would be a
  // second implementation of the destructive ladder, and two implementations of a
  // safety rule diverge — the client would offer a plain confirm for a statement
  // the server refuses without a typed name, and the dialog would be wrong in the
  // direction that matters. The server stays authoritative: this copy decides what
  // the dialog *asks for*, never what runs.
  transpilePackages: ['@steadhold/types', '@steadhold/sql-guard'],
};
export default nextConfig;
