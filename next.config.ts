// SPDX-License-Identifier: AGPL-3.0-only
/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.groupmind.one' }],
        destination: 'https://groupmind.one/:path*',
        permanent: true,
      },
      {
        source: '/terrains',
        destination: '/spaces',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'antfarm.thinkoff.io' }],
        destination: 'https://groupmind.one/:path*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
