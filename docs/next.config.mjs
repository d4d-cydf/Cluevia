import { createMDX } from 'fumadocs-mdx/next';

export default createMDX()({
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: (process.env.CLUEVIA_DOCS_ALLOWED_ORIGINS || '').split(',').map((host) => host.trim()).filter(Boolean),
  agentRules: false,
  turbopack: { root: import.meta.dirname },
});
