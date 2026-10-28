# 无名杀 · 联机版（本地测试说明）

技术栈：Next.js 15 (App Router + Turbopack) · TypeScript · shadcn/Tailwind · socket.io

## 目录结构

- `src/` — 前端页面与协议客户端（页面只有 `/` 一个路由：大厅 + 房间 + 牌桌）
- `mini-services/noname-server/` — 联机服务（socket.io，端口 3003，服务端权威卡牌引擎）
- 协议 v1：消息 = `{ t, seq?, d? }`，带 seq 必回 ack，事件走 `evt`；协议里只有数据，没有代码

## 本地运行（两个终端）

**终端 1 — 联机服务（先起）：**

```bash
cd mini-services/noname-server
bun install        # 或 npm install
bun run dev        # 监听 3003，支持热重载
```

**终端 2 — 前端：**

```bash
bun install        # 项目根目录；或 npm install
echo 'NEXT_PUBLIC_GAME_SERVER=http://localhost:3003' > .env.local
bun run dev        # 监听 3000
```

打开 http://localhost:3000 ，输昵称进大厅 → 创建房间。
本机开两个浏览器窗口（或一个正常 + 一个无痕）进同一房间、都点「准备」即可开局。

## 规则速览

- 2~8 人，每人 4 体力；起手摸 4，先手摸 2
- 牌堆：杀×24 / 闪×18 / 桃×12 / 无中生有×6
- 每回合限一张【杀】，需点选目标；被杀者 8 秒内可打【闪】抵消
- 濒死时可打【桃】自救；结束时弃牌至体力数；最后存活者获胜

## 已知边界

- 断线重连后视为新玩家进入（旧席位判负），刷新页面即回到大厅
- 桃只能在濒死/自己回合使用（当前实现：回合内回血 + 濒死自救）
