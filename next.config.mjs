/**
 * 纯 JS 配置（mjs）：生产环境加载配置零转译，
 * 不依赖 swc 原生绑定（宝塔/平台精简安装场景更稳）。
 *
 * @type {import('next').NextConfig}
 */
const projectDir = process.cwd();

const nextConfig = {
  // 构建目录用非隐藏名：平台打包会过滤点开头的隐藏目录（.next 带不上）
  distDir: "next-dist",
  outputFileTracingRoot: projectDir,
  turbopack: {
    root: projectDir,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
