/**
 * 联机 mini-service：socket.io 承载协议 v1，端口 3003（经 Caddy 网关转发）。
 * 前端连接方式：io("/?XTransformPort=3003")
 */
import { createServer } from "http";
import { Server } from "socket.io";
import { Lobby } from "./src/lobby";

const httpServer = createServer();
const io = new Server(httpServer, {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 16 * 1024,
});

const lobby = new Lobby();
io.on("connection", socket => lobby.onConnection(socket));

const PORT = 3003;
httpServer.listen(PORT, () => {
  console.log(`[noname-server] 联机服务运行于 :${PORT}，端点 /?XTransformPort=3003`);
});

process.on("SIGTERM", () => {
  lobby.stop();
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  lobby.stop();
  httpServer.close(() => process.exit(0));
});
