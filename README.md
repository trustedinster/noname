# 无名杀 · 联机版（next-arch）

基于开源项目 [无名杀（noname）](https://github.com/trustedinster/noname)（上游为 [libnoname/noname](https://github.com/libnoname/noname)，GPL-3.0）的**服务端权威联机重构版**。

原版的联机架构是「服务器只做房间转发，对局逻辑由房主的浏览器客户端跑」，本仓库把对局引擎搬到了服务端：前端（Next.js）只负责展示与操作，全部规则结算由 Node 进程权威完成。

## 与原版架构的对比

| | 原版（客户端权威） | 本方案（服务端权威） |
|---|---|---|
| 对局运行位置 | 房主浏览器跑整套 classic 引擎 | Node 单进程轻量引擎（纯 TS 数据结构 + 事件机） |
| 服务器资源 | headless 托管需 electron/puppeteer 级常驻（数百 MB 起） | 无需浏览器内核，进程常驻 ~100MB，单局状态 KB 级 |
| 安全边界 | 客户端可推代码 / 扩展直读写服务端文件系统 | **协议红线：只有数据，永远没有代码**——客户端仅能发白名单指令，服务端是唯一执行体，无 fs 暴露、无动态 eval |
| 部署适配 | 无扩展名脚本、怪路径，nginx 默认防护规则易误杀 | 标准 Next 应用（`/_next/` + `/socket.io`），宝塔标准反代即可 |
| 安装 | 资源包 + 运行环境繁琐 | `npm install && npm run build && npm start` 三步 |
| 客户端 | 需要完整前端环境 | 任何浏览器（含手机），零插件零内核 |

## 模式（按人数自动匹配）

| 人数 | 模式 | 规则 |
|---|---|---|
| 2 | 1v1 | 对立阵营，一方倒下即分胜负 |
| 3 | 斗地主 | 1 地主 vs 2 农民（地主开局亮身份） |
| 4 | 2v2 | 团队对抗，同队互见 |
| 5 / 6 / 7 | 暂无 | 全员准备也无法开局（提示等待） |
| 8 | 军争八人身份场 | 主公 1（+1 体力、开局亮身份）/ 忠臣 2 / 反贼 4 / 内奸 1 |

对局机制：标准回合阶段机（准备→判定→摸牌→出牌→弃牌→结束）、环形座位距离与攻击范围、装备区（武器/防具/±1 坐骑）、酒（杀伤害 +1 / 濒死自救）、濒死全桌求桃、80 张花色点数牌堆。

## 部署

见 [deploy-宝塔.md](./deploy-宝塔.md)（宝塔面板三步走：装 Node → install + build → Node 项目守护 + 反代补 WebSocket 头）。

```bash
npm install
npm run build
npm start          # 默认 :3000，页面与联机同端口
```

## 开发

```bash
npm run dev        # 同端口热重载
```

代码结构：

```
server.ts                        单进程入口（Next + socket.io 合并）
mini-services/noname-server/
  src/protocol.ts                协议 v1.1（只有数据，没有代码）
  src/modes.ts                   模式/身份/胜负判定配置
  src/lobby.ts                   大厅与房间
  src/sgs-lite.ts                服务端权威对局引擎
src/app/page.tsx                 牌桌（原版布局：头像环绕 / 重叠手牌）
```

## License

遵循上游 GPL-3.0。资源文件（背景图等）版权归无名杀原项目所有。
