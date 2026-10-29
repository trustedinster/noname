/**
 * PM2 进程守护配置（宝塔 PM2 管理器 / 服务器裸 PM2 通用）。
 * 用法：在项目根目录执行  pm2 start ecosystem.config.js && pm2 save
 * 注意：先完成 npm install 与 npm run build（产物 dist/server.js + .next）。
 */
module.exports = {
  apps: [
    {
      name: "noname",
      // 编译产物，纯 node 运行，无 ts/bun 运行时依赖
      script: "dist/server.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      max_memory_restart: "512M",
      // socket.io 长连接：平滑重载时给存量连接留时间
      kill_timeout: 10000,
      autorestart: true,
    },
  ],
};
