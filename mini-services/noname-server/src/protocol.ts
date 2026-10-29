/**
 * 协议 v1.1 —— 大功能①：基础对局完整化
 * 消息 = { t, seq?, d? }，带 seq 的指令必回 ack。
 * 传输层 socket.io：客户端 → 服务端 emit("msg")，服务端 → 客户端 emit("ack"/"evt")。
 *
 * v1.1 变更：
 *  - Card 增加花色/点数/类别/装备槽（为判定、锦囊做地基）
 *  - 回合阶段机（准备/判定/摸牌/出牌/弃牌/结束）
 *  - 座位距离与攻击范围、装备区（武器/防具/+1马/-1马）
 *  - 濒死全桌求桃顺位、酒
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

/* ---------------- 牌 ---------------- */

export type Suit = "spade" | "heart" | "club" | "diamond";
export type CardType = "basic" | "trick" | "equip" | "delayed";
export type EquipSlot = "weapon" | "armor" | "horse+" | "horse-";

/** 协议对外牌名（服务端权威） */
export type CardKind =
  | "sha" | "shan" | "tao" | "jiu"          // 基本
  | "bagua" | "qinglong" | "fangtian" | "liannu"   // 防具/武器
  | "horse_plus" | "horse_minus";            // 坐骑

export interface Card {
  id: number;
  kind: CardKind;
  type: CardType;
  suit: Suit;
  /** 点数 A=1 … K=13 */
  rank: number;
  /** 装备牌才有：槽位 + 武器攻击范围 */
  equip?: { slot: EquipSlot; range?: number };
}

export const CARD_NAMES: Record<CardKind, string> = {
  sha: "杀",
  shan: "闪",
  tao: "桃",
  jiu: "酒",
  bagua: "八卦阵",
  qinglong: "青龙偃月刀",
  fangtian: "方天画戟",
  liannu: "诸葛连弩",
  horse_plus: "+1马",
  horse_minus: "-1马",
};

export const SUIT_SYMBOL: Record<Suit, string> = {
  spade: "♠",
  heart: "♥",
  club: "♣",
  diamond: "♦",
};

export const SUIT_RED: Record<Suit, boolean> = {
  spade: false,
  heart: true,
  club: false,
  diamond: true,
};

/* ---------------- 玩家与状态 ---------------- */

export interface EquipView {
  slot: EquipSlot;
  kind: CardKind;
  name: string;
  suit: Suit;
  rank: number;
}

export interface PlayerBrief {
  seat: number;
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  handCount: number;
  dead: boolean;
  /** 对当前回合行动者：能否用【杀】打到（含距离/范围/坐骑修正） */
  inRange: boolean;
  /** 距当前回合行动者的环上距离（含坐骑修正后） */
  dist: number;
  equip: EquipView[];
  /** 身份名。公开广播仅在对局结束后填充；对局中的可见身份走 private 的 visibleRoles */
  role?: string | null;
}

export type TurnPhase =
  | "prepare" | "judgment" | "draw" | "play" | "discard" | "finish";

export interface Prompt {
  /** shan: 需要闪；tao: 濒死求桃 */
  type: "shan" | "tao";
  seat: number;
  fromSeat: number | null;
  /** 濒死求桃时：为谁求 */
  dyingSeat?: number;
  until: number;
}

/** 公共可见的对局状态（不含任何手牌） */
export interface PublicGameState {
  players: PlayerBrief[];
  turnSeat: number;
  /** 对局大阶段 */
  phase: "play" | "over";
  /** 当前回合内的阶段 */
  turnPhase: TurnPhase;
  prompt: Prompt | null;
  /** 本回合已使用【杀】 */
  shaUsed: boolean;
  /** 本回合已使用【酒】（出牌阶段增益限一次） */
  wineUsed: boolean;
  /** 牌堆剩余（洗入弃牌重置后） */
  deckCount: number;
  discardCount: number;
  winner: string | null;
  /** 模式名（如「军争八人身份场」） */
  modeName: string | null;
}

export interface RoomSummary {
  id: string;
  name: string;
  game: string;
  mode: string;
  players: number;
  max: number;
  started: boolean;
  over: boolean;
}

export interface RoomState {
  id: string;
  name: string;
  game: string;
  mode: string;
  modeUnavailable: boolean;
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
