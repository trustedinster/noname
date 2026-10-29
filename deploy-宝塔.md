# 宝塔面板部署指南（无名杀 · 联机版）

单进程架构：一个 Node 进程同时跑 Next 页面和 socket.io（`/socket.io` 路径），**只需反代一个端口**。
启动走编译产物 `node dist/server.js`，运行时零工具依赖（tsx/bun 都不需要），服务器只要 Node ≥ 20。

---

## 一、装环境（宝塔软件商店）

1. **Node.js 版本管理器** → 安装 Node 20 / 22 任一
2. **PM2 管理器**（二选一场景见第四节；新版宝塔自带「Node 项目」功能的话可跳过）

---

## 二、上传代码

打包上传（或 git clone）到如 `/www/wwwroot/noname/`。

**不要传** `node_modules` 和 `.next`（体积大且可能有平台差异），服务器上现场装。
`.env.local` 不需要——前端默认同源连接，零配置。

---

## 三、安装与构建（终端执行）

```bash
cd /www/wwwroot/noname
npm install          # bun.lock 不影响 npm；服务器装了 bun 的话 bun install 更快
npm run build        # Next 构建
```

> ⚠️ 内存提醒：`next build` 吃内存，1G 小鸡先加 2G swap：
> `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`
> 或者本地 build 完把 `next-dist` 和 `dist` 目录一起打包上传，服务器跳过 build。

---

## 四、启动（统一走宝塔管理，⚠️ 不要终端手动 pm2）

> 手动 `pm2 start` 起的进程不显示在宝塔面板里，和宝塔的项目管理容易打架
> （双进程抢 3000 端口）。之前手动起过的先清掉：
> ```bash
> pm2 delete noname && pm2 save
> pm2 kill   # 服务器没有其他 pm2 项目时才执行
> ```

**方式 A · 宝塔「Node 项目」（推荐，新版宝塔自带）**

网站 → Node项目 → 添加Node项目：
- 项目目录：`/www/wwwroot/noname-pro`
- 启动选项：`start`（自动识别 package.json scripts）
- 端口：`3000`

宝塔自动守护 + 开机自启 + 面板可视化重启/看日志。

**方式 B · 宝塔「PM2 管理器」插件**

软件商店安装 PM2 管理器 → 面板内「添加项目」→ 项目目录选 `noname-pro`，启动文件选 `dist/server.js`。同样在面板内管理，效果等同方式 A。

验证：`pm2 logs noname` 看到 `[noname] 单进程运行于 :3000` 即成功；
`curl 127.0.0.1:3000` 返回 HTML、`curl "127.0.0.1:3000/socket.io/?EIO=4&transport=polling"` 返回 `0{"sid":...}`。

---

## 五、反向代理 + WebSocket（最大的坑，必看）

网站 → 添加站点（绑定你的域名，如 `noname.example.com`）→ 设置 → **反向代理** → 添加反向代理：
- 目标 URL：`http://127.0.0.1:3000`
- 发送域名：`$host`

添加后点「配置文件」，把 proxy 部分替换成下面这段（宝塔默认模板**不带 WebSocket 头**，不加的话 socket.io 连不上或疯狂降级轮询）：

```nginx
location /
{
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

**SSL**：设置 → SSL → Let's Encrypt 一键签。浏览器 https 页面禁止 ws 明文连接，反代同源后 socket.io 自动走 wss，前端无需任何改动。

---

## 六、注意事项

| 事项 | 说明 |
|---|---|
| **别挂子目录** | Next 静态资源是绝对路径 `/_next/...`，挂在现有站点 `/game/` 子目录会 404。用**子域名**或独立站点 |
| 防火墙 | 不需要放行 3000，只走 80/443 反代，更安全 |
| 端口冲突 | 3000 被占：方式 A 直接改端口；方式 B 改 `ecosystem.config.js` 的 `PORT`。前端零配置，跟着同源走 |
| 玩家上限 | 引擎默认 2~8 人/房，房间数有上限（protocol.ts `LIMITS`），小水管够用 |
| 更新版本 | 传新代码 → `npm run build` → `pm2 restart noname`（或宝塔 Node 项目点重启） |

## 七、排障速查

- **进大厅一直转圈 / 无房间列表** → 九成是反代没加 WebSocket 头，回第五节
- **浏览器控制台报 `websocket connection failed` 后自动恢复** → 降级到 polling 了，能玩但延迟高，同样补 WS 头
- **pm2 起不来** → `pm2 logs noname --err`；确认 Node ≥ 20：`node -v`
- **build 报内存不足** → 见第三节 swap 方案
