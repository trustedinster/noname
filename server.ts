/**
 * 单进程入口：Next.js 页面与 socket.io 游戏服务（协议 v1）合并于同一 HTTP 端口。
 *
 * - 生产：npm run start（tsx，纯 Node 生态，宝塔/PM2 友好）；或 npm run start:bun
 * - 开发：npm run dev（同端口，带热重载）
 * - socket.io 挂在默认路径 /socket.io，与页面路由互不干扰
 *
 * mini-services/noname-server 保留为独立直连模式（经 Caddy 网关 XTransformPort），
 * 逻辑层（Lobby / SgsLiteHost / protocol）与本入口共享同一份代码。
 */
import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { Lobby } from "./mini-services/noname-server/src/lobby";
import { APP_VERSION } from "./src/lib/version";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT) || 3000;

async function main() {
  const app = next({ dev });
  const handle = app.getRequestHandler();

  await app.prepare();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 16 * 1024,
  });

  const lobby = new Lobby();
  io.on("connection", socket => lobby.onConnection(socket));

  httpServer.listen(port, () => {
    console.log(
      `[noname] v${APP_VERSION} 单进程运行于 :${port}（Next 页面 + socket.io /socket.io），dev=${dev}`,
    );
  });

  const shutdown = () => {
    lobby.stop();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
