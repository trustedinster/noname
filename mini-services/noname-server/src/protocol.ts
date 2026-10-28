/**
 * 协议 v1 —— 与独立版 noname-server 同一套设计：
 * 消息 = { t, seq?, d? }，带 seq 的指令必回 ack。
 * 传输层换成 socket.io：
 *   客户端 → 服务端：socket.emit("msg", { t, seq, d })
 *   服务端 → 客户端：socket.emit("ack", { seq, ok, d? }) / socket.emit("evt", { t, d })
 *
 * 红线：协议里只有数据，永远没有代码。
 */

export const LIMITS = {
  name: 12,
  roomName: 20,
  maxMessageBytes: 16 * 1024,
  chat: 120,
  maxRooms: 100,
  maxPlayersPerRoom: 8,
  helloTimeoutMs: 8000,
};

export type CardKind = "sha" | "shan" | "tao" | "wuzhong";

export interface Card {
  id: number;
  kind: CardKind;
}

export const CARD_NAMES: Record<CardKind, string> = {
  sha: "杀",
  shan: "闪",
  tao: "桃",
  wuzhong: "无中生有",
};

export interface PlayerBrief {
  seat: number;
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  handCount: number;
  dead: boolean;
}

export interface Prompt {
  type: "shan" | "tao";
  /** 被询问者的座位 */
  seat: number;
  /** 谁在等你响应 */
  fromSeat: number | null;
  /** 响应截止时间戳（客户端倒计时） */
  until: number;
}

/** 公共可见的对局状态（不含任何手牌） */
export interface PublicGameState {
  players: PlayerBrief[];
  turnSeat: number;
  phase: "play" | "over";
  prompt: Prompt | null;
  shaUsed: boolean;
  discardCount: number;
  winner: string | null;
}

export interface RoomSummary {
  id: string;
  name: string;
  game: string;
  players: number;
  max: number;
  started: boolean;
  over: boolean;
}

export interface RoomState {
  id: string;
  name: string;
  game: string;
  members: { id: string; name: string; ready: boolean }[];
  started: boolean;
  over: boolean;
}

/** 校验客户端指令信封 */
export function decodeEnvelope(
  raw: unknown
): { t: string; seq?: number; d?: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.t !== "string") return null;
  if (msg.seq !== undefined && typeof msg.seq !== "number") return null;
  if (msg.d !== undefined && (typeof msg.d !== "object" || msg.d === null)) return null;
  return msg as { t: string; seq?: number; d?: Record<string, unknown> };
}
