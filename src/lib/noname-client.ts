"use client";
/**
 * 新协议 v1 客户端（socket.io 承载，经 Caddy 网关）。
 * 消息 = { t, seq?, d? }；带 seq 必回 ack；事件走 "evt"。
 * 红线：协议里只有数据，永远没有代码。
 */
import { io, type Socket } from "socket.io-client";

/**
 * 线上走 Caddy 网关（相对路径 /?XTransformPort=3003）；
 * 本地调试可设 NEXT_PUBLIC_GAME_SERVER=http://localhost:3003 直连。
 */
const SERVER_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_GAME_SERVER) || "/?XTransformPort=3003";

export type Evt = { t: string; d: any };

export class NonameClient {
  private socket: Socket | null = null;
  private seq = 0;
  private pending = new Map<number, { res: (d: any) => void; rej: (e: Error) => void }>();
  private evtHandlers: ((e: Evt) => void)[] = [];

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(SERVER_URL, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 5,
      });
      this.socket.on("connect", () => resolve());
      this.socket.on("connect_error", (e: Error) => reject(e));
      this.socket.on("ack", (m: any) => {
        if (m?.seq !== undefined && this.pending.has(m.seq)) {
          const p = this.pending.get(m.seq)!;
          this.pending.delete(m.seq);
          if (m.ok) p.res(m.d);
          else p.rej(new Error(m.d?.message ?? m.d?.code ?? "请求失败"));
        }
      });
      this.socket.on("evt", (m: Evt) => this.evtHandlers.forEach(h => h(m)));
      this.socket.on("disconnect", () => {
        this.pending.forEach(p => p.rej(new Error("连接已断开")));
        this.pending.clear();
      });
    });
  }

  onEvt(h: (e: Evt) => void) {
    this.evtHandlers.push(h);
    return () => {
      this.evtHandlers = this.evtHandlers.filter(x => x !== h);
    };
  }

  get connected() {
    return this.socket?.connected ?? false;
  }

  request(t: string, d?: unknown): Promise<any> {
    return new Promise((res, rej) => {
      if (!this.socket?.connected) return rej(new Error("未连接"));
      const seq = ++this.seq;
      this.pending.set(seq, { res, rej });
      this.socket.emit("msg", { t, seq, d });
    });
  }

  close() {
    this.socket?.disconnect();
    this.socket = null;
  }
}
