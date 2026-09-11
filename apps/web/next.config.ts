import type { NextConfig } from 'next';

const config: NextConfig = {
  // Deployed to Cloud Run beside the API rather than to Vercel (build plan D7): one
  // vendor, one INR invoice, one region, one pipeline.
  output: 'standalone',
  reactStrictMode: true,
  typedRoutes: true,
};

export default config;
