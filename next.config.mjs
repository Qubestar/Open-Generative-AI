/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['studio', 'ai-agent', 'workflow-builder'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'oaidalleapiprodscus.blob.core.windows.net',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'generativelanguage.googleapis.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'api.x.ai',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'api.muapi.ai',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'cdn.muapi.ai',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'api.recraft.ai',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'api.together.xyz',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'api.siliconflow.cn',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://api.muapi.ai/api/:path*',
      },
    ];
  },
};

export default nextConfig;
