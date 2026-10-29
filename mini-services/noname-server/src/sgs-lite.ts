/**
 * GameHost 实现：无名杀·轻量版（服务端权威托管）
 *
 * 大功能① 范围（协议 v1.1）：
 *  - 标准回合阶段机：准备 → 判定 → 摸牌 → 出牌 → 弃牌 → 结束
 *  - 环形座位距离 + 攻击范围 + 坐骑修正（+1马/-1马）
 *  - 装备区 4 槽：武器（连弩不限杀 / 青龙刀 3 / 方天戟 4）、防具（八卦阵：判红视为闪）、±1 马
 *  - 酒：出牌阶段令下一张杀伤害 +1（每回合一次）；濒死时可当桃自救
 *  - 濒死：从濒死者起按座次顺位向持有【桃】者求桃（简化：仅询问持牌者）
 *  - 牌堆 80 张带花色点数（基础牌随机分配），弃牌堆洗回
 *  - 弃牌阶段：手牌自动弃至当前体力（装备不计入手牌上限）
 *  - 胜负：最后存活者胜（无身份，身份局归后续大功能）
 *
 * 响应均有服务端超时（杀/闪 8s，求桃 6s），超时视同放弃。
 * 对外接口（start/handleAction/removePlayer/dispose）与 headless 引擎约定一致，
 * 后续整包引擎替换此文件即可，大厅/房间/协议层零改动。
 */
import type {
  Card, CardKind, CardType, EquipSlot, PublicGameState, PlayerBrief,
  Prompt, Suit, TurnPhase,
} from "./protocol";
import { CARD_NAMES } from "./protocol";

export interface HostPlayer {
  id: string;
  name: string;
}

interface SeatState {
  seat: number;
  playerId: string;
  name: string;
  hp: number;
  maxHp: number;
  hand: Card[];
  equip: Partial<Record<EquipSlot, Card>>;
  dead: boolean;
}

interface PendingAsk {
  seat: number;
  type: "shan" | "tao";
  fromSeat: number | null;
  dyingSeat?: number;
  until: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (cardId: number | null) => void;
}

const ASK_MS = 8000;
const ASK_DYING_MS = 6000;

/* ---------------- 牌堆定义（①版：基础 + 装备，锦囊归后续大功能） ---------------- */

const BASIC_SPEC: [CardKind, number][] = [
  ["sha", 30], ["shan", 22], ["tao", 12], ["jiu", 4],
];

const SUITS: Suit[] = ["spade", "heart", "club", "diamond"];

const EQUIP_SPEC: { kind: CardKind; slot: EquipSlot; range?: number; suit: Suit; rank: number }[] = [
  { kind: "liannu", slot: "weapon", range: 1, suit: "diamond", rank: 1 },
  { kind: "qinglong", slot: "weapon", range: 3, suit: "spade", rank: 5 },
  { kind: "fangtian", slot: "weapon", range: 4, suit: "diamond", rank: 12 },
  { kind: "bagua", slot: "armor", suit: "spade", rank: 2 },
  { kind: "horse_plus", slot: "horse+", suit: "club", rank: 5 },
  { kind: "horse_plus", slot: "horse+", suit: "spade", rank: 5 },
  { kind: "horse_plus", slot: "horse+", suit: "heart", rank: 13 },
  { kind: "horse_minus", slot: "horse-", suit: "heart", rank: 5 },
  { kind: "horse_minus", slot: "horse-", suit: "spade", rank: 13 },
  { kind: "horse_minus", slot: "horse-", suit: "diamond", rank: 8 },
];

const KIND_TYPE: Record<CardKind, CardType> = {
  sha: "basic", shan: "basic", tao: "basic", jiu: "basic",
  liannu: "equip", qinglong: "equip", fangtian: "equip", bagua: "equip",
  horse_plus: "equip", horse_minus: "equip",
};

export class SgsLiteHost {
  private roster: { id: string; name: string; seat: number }[] = [];
  private seats: SeatState[] = [];
  private deck: Card[] = [];
  private discard: Card[] = [];
  private nextCardId = 1;
  private turnSeat = 0;
  private turnPhase: TurnPhase = "prepare";
  private shaUsed = false;
  private wineUsed = false;
  /** 本回合是否已用酒增益（下一杀 +1 伤害） */
  private wineBuff = false;
  private over = false;
  private winner: string | null = null;
  private phase: "idle" | "play" | "over" = "idle";
  private pending: PendingAsk | null = null;
  private playResolve: (() => void) | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private io: {
      broadcast: (t: string, d: unknown) => void;
      sendTo: (playerId: string, t: string, d: unknown) => void;
      log: (text: string) => void;
    }
  ) {}

  /* ---------------- GameHost 接口 ---------------- */

  addPlayer(p: HostPlayer) {
    if (this.phase === "play") return; // 开局后进来的都是观战
    if (this.roster.some(r => r.id === p.id)) return;
    const used = new Set(this.roster.map(r => r.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    this.roster.push({ id: p.id, name: p.name, seat });
  }

  removePlayer(playerId: string) {
    this.enqueue(async () => {
      this.roster = this.roster.filter(r => r.id !== playerId);
      const s = this.seats.find(x => x.playerId === playerId);
      if (!s || s.dead || this.phase !== "play") return;
      this.discard.push(...s.hand, ...Object.values(s.equip).filter(Boolean) as Card[]);
      s.hand = [];
      s.equip = {};
      s.dead = true;
      this.io.log(`${s.name} 离开对局，判负`);
      if (this.pending?.seat === s.seat) this.resolveAsk(null);
      if (this.turnSeat === s.seat) this.endPlayPhase();
      await this.checkGameOver();
      this.publish();
    });
  }

  setReady(_playerId?: string, _ready?: boolean) {}

  maybeStart() {
    this.enqueue(async () => {
      if (this.phase === "play" || this.roster.length < 2) return;
      this.begin();
    });
  }

  handleAction(playerId: string, action: { type?: unknown; data?: unknown }) {
    const type = String(action?.type ?? "");

    // 响应动作同步结算：解除正在等待的串行队列，否则自我死锁
    if (type === "respond" && this.pending) {
      const s = this.seats.find(x => x.playerId === playerId);
      if (s && this.pending.seat === s.seat) {
        const data = (action?.data ?? {}) as Record<string, unknown>;
        if (data.cardId === null || data.cardId === undefined) {
          this.io.log(`${s.name} 放弃响应`);
          this.resolveAsk(null);
          return;
        }
        const cardId = Number(data.cardId);
        const card = s.hand.find(c => c.id === cardId);
        const dyingSelf = this.pending.dyingSeat === s.seat;
        const okKind =
          card && (card.kind === this.pending.type || (this.pending.type === "tao" && dyingSelf && card.kind === "jiu"));
        if (okKind) {
          this.resolveAsk(cardId);
          return;
        }
        this.io.sendTo(playerId, "game.event", { kind: "invalid", reason: "bad-response" });
        return;
      }
    }

    this.enqueue(async () => {
      if (this.phase !== "play") return;
      const data = (action?.data ?? {}) as Record<string, unknown>;
      try {
        await this.dispatch(playerId, type, data);
      } catch (e) {
        this.io.sendTo(playerId, "game.event", {
          kind: "invalid",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  dispose() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.playResolve = null;
  }

  summary() {
    return { started: this.phase === "play", over: this.phase === "over" };
  }

  /* ---------------- 生命周期 ---------------- */

  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn, () => fn());
  }

  private begin() {
    this.deck = this.buildDeck();
    this.discard = [];
    this.seats = this.roster.map(r => ({
      seat: r.seat,
      playerId: r.id,
      name: r.name,
      hp: 4,
      maxHp: 4,
      hand: [],
      equip: {},
      dead: false,
    }));
    for (const s of this.seats) s.hand = this.draw(4);
    this.turnSeat = this.seats[0].seat;
    this.shaUsed = false;
    this.wineUsed = false;
    this.wineBuff = false;
    this.over = false;
    this.winner = null;
    this.phase = "play";
    this.io.log("对局开始：起手摸 4。装备牌打出后置于装备区，不占手牌上限");
    this.io.broadcast("game.start", {
      seats: this.seats.map(s => ({ seat: s.seat, playerId: s.playerId, name: s.name })),
    });
    this.publish();
    void this.gameLoop();
  }

  private buildDeck(): Card[] {
    const cards: Card[] = [];
    for (const [kind, n] of BASIC_SPEC) {
      for (let i = 0; i < n; i++) {
        cards.push({
          id: this.nextCardId++,
          kind,
          type: KIND_TYPE[kind],
          suit: SUITS[Math.floor(Math.random() * 4)],
          rank: 1 + Math.floor(Math.random() * 13),
        });
      }
    }
    for (const e of EQUIP_SPEC) {
      cards.push({
        id: this.nextCardId++,
        kind: e.kind,
        type: "equip",
        suit: e.suit,
        rank: e.rank,
        equip: { slot: e.slot, range: e.range },
      });
    }
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  private draw(n: number): Card[] {
    const out: Card[] = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) break;
        this.deck = this.discard;
        this.discard = [];
        for (let j = this.deck.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1));
          [this.deck[j], this.deck[k]] = [this.deck[k], this.deck[j]];
        }
        this.io.log("牌堆已尽，弃牌堆洗回");
      }
      const c = this.deck.pop();
      if (c) out.push(c);
    }
    return out;
  }

  private bySeat(seat: number): SeatState | undefined {
    return this.seats.find(s => s.seat === seat);
  }

  private alive(): SeatState[] {
    return this.seats.filter(s => !s.dead);
  }

  /* ---------------- 回合循环与阶段机 ---------------- */

  private async gameLoop() {
    while (!this.over && this.phase === "play") {
      const s = this.bySeat(this.turnSeat);
      if (!s || s.dead) {
        this.turnSeat = this.nextAliveSeat(this.turnSeat);
        continue;
      }
      await this.runTurn(s);
      if (this.over) break;
      this.turnSeat = this.nextAliveSeat(this.turnSeat);
    }
  }

  private nextAliveSeat(from: number): number {
    const order = this.alive().map(x => x.seat).sort((a, b) => a - b);
    return order.find(x => x > from) ?? order[0];
  }

  private setPhase(p: TurnPhase) {
    this.turnPhase = p;
    this.publish();
  }

  private async runTurn(s: SeatState) {
    this.shaUsed = false;
    this.wineUsed = false;
    this.wineBuff = false;

    this.setPhase("prepare");
    this.io.log(`—— ${s.name} 的回合 ——`);

    this.setPhase("judgment"); // ①无延时锦囊，判定阶段预留
    this.setPhase("draw");
    const drawn = this.draw(2);
    s.hand.push(...drawn);
    this.io.log(`${s.name} 摸 2 张`);
    this.publish();

    // 出牌阶段：等待玩家「结束回合」
    this.turnPhase = "play";
    this.publish();
    await this.waitPlayDecision();

    if (this.over) return;

    this.setPhase("discard");
    if (s.hand.length > s.hp) {
      const dropped = s.hand.slice(s.hp);
      this.discard.push(...dropped);
      s.hand = s.hand.slice(0, s.hp);
      this.io.log(`${s.name} 弃置 ${dropped.length} 张手牌（手牌上限 = 体力）`);
    }
    this.publish();

    this.setPhase("finish");
  }

  private waitPlayDecision(): Promise<void> {
    return new Promise(res => { this.playResolve = res; });
  }

  private endPlayPhase() {
    const r = this.playResolve;
    this.playResolve = null;
    r?.();
  }

  /* ---------------- 距离与装备 ---------------- */

  private ringDist(a: number, b: number): number {
    const order = this.alive().map(x => x.seat).sort((x, y) => x - y);
    const ia = order.indexOf(a), ib = order.indexOf(b);
    const n = order.length;
    if (ia < 0 || ib < 0 || n === 0) return 99;
    return Math.min((ib - ia + n) % n, (ia - ib + n) % n);
  }

  /** from 视角到 to 的距离（含坐骑修正，最小 1） */
  private distFrom(from: SeatState, to: SeatState): number {
    let d = this.ringDist(from.seat, to.seat);
    if (from.equip["horse-"]) d -= 1;
    if (to.equip["horse+"]) d += 1;
    return Math.max(1, d);
  }

  private attackRange(s: SeatState): number {
    return s.equip.weapon?.equip?.range ?? 1;
  }

  private equipView(s: SeatState) {
    return (Object.entries(s.equip) as [EquipSlot, Card][])
      .filter(([, c]) => Boolean(c))
      .map(([slot, c]) => ({ slot, kind: c.kind, name: CARD_NAMES[c.kind], suit: c.suit, rank: c.rank }));
  }

  /* ---------------- 出牌 ---------------- */

  private async dispatch(playerId: string, type: string, data: Record<string, unknown>) {
    if (type === "respond") return this.onRespond(playerId, data);

    const s = this.bySeat(this.turnSeat);
    if (!s || s.playerId !== playerId) throw new Error("not-your-turn");
    if (this.turnPhase !== "play") throw new Error("not-play-phase");
    if (type === "end") {
      this.io.log(`${s.name} 结束出牌阶段`);
      this.endPlayPhase();
      return;
    }
    if (type !== "play") throw new Error("bad-action");

    const cardId = Number(data.cardId);
    const idx = s.hand.findIndex(c => c.id === cardId);
    if (idx < 0) throw new Error("no-such-card");
    const card = s.hand[idx];

    switch (card.kind) {
      case "sha": {
        if (this.shaUsed && s.equip.weapon?.kind !== "liannu") throw new Error("sha-used");
        const target = this.bySeat(Number(data.targetSeat));
        if (!target || target.dead || target.seat === s.seat) throw new Error("bad-target");
        if (this.distFrom(s, target) > this.attackRange(s)) throw new Error("out-of-range");
        s.hand.splice(idx, 1);
        this.discard.push(card);
        this.shaUsed = true;
        const dmg = this.wineBuff ? 2 : 1;
        const wineNote = this.wineBuff ? "（酒后伤害 +1）" : "";
        this.io.log(`${s.name} 对 ${target.name} 使用【杀】${wineNote}`);
        this.wineBuff = false;
        this.publish();
        await this.resolveSha(s, target, dmg);
        return;
      }
      case "jiu": {
        if (this.wineUsed) throw new Error("jiu-used");
        s.hand.splice(idx, 1);
        this.discard.push(card);
        this.wineUsed = true;
        this.wineBuff = true;
        this.io.log(`${s.name} 使用【酒】：本回合下一张【杀】伤害 +1`);
        this.publish();
        return;
      }
      case "tao": {
        if (s.hp >= s.maxHp) throw new Error("hp-full");
        s.hand.splice(idx, 1);
        this.discard.push(card);
        s.hp = Math.min(s.maxHp, s.hp + 1);
        this.io.log(`${s.name} 使用【桃】，回复至 ${s.hp} 体力`);
        this.publish();
        return;
      }
      case "bagua":
      case "liannu":
      case "qinglong":
      case "fangtian":
      case "horse_plus":
      case "horse_minus": {
        const slot = card.equip!.slot;
        const old = s.equip[slot];
        s.hand.splice(idx, 1);
        s.equip[slot] = card;
        if (old) this.discard.push(old);
        this.io.log(`${s.name} 装备了【${CARD_NAMES[card.kind]}】${old ? `（替换【${CARD_NAMES[old.kind]}】）` : ""}`);
        this.publish();
        return;
      }
      case "shan":
      default:
        throw new Error("card-not-playable");
    }
  }

  private async resolveSha(source: SeatState, target: SeatState, dmg: number) {
    // 八卦阵：需要闪时先判定，红色视为闪（①简化为自动发动）
    if (target.equip.armor?.kind === "bagua") {
      const j = await this.judge(target, "八卦阵");
      if (j.suit === "heart" || j.suit === "diamond") {
        this.io.log(`${target.name} 的【八卦阵】判定为红色，视为打出【闪】`);
        this.publish();
        return;
      }
      this.io.log(`${target.name} 的【八卦阵】判定为黑色，仍需打出【闪】`);
    }
    const dodgeId = await this.ask(target.seat, "shan", source.seat);
    if (dodgeId !== null) {
      const card = target.hand.find(c => c.id === dodgeId);
      if (card?.kind === "shan") {
        target.hand = target.hand.filter(c => c.id !== dodgeId);
        this.discard.push(card);
        this.io.log(`${target.name} 打出【闪】，抵消了【杀】`);
        this.publish();
        return;
      }
    }
    this.io.log(`${target.name} 未响应，受到 ${dmg} 点伤害`);
    await this.damage(target, dmg);
    this.publish();
  }

  /** 从牌堆顶翻开一张判定牌（进弃牌堆） */
  private async judge(who: SeatState, reason: string): Promise<Card> {
    const [card] = this.draw(1);
    if (!card) throw new Error("deck-empty");
    this.discard.push(card);
    const sym = card.suit === "spade" || card.suit === "club" ? "黑" : "红";
    this.io.log(`${who.name} 进行【${reason}】判定：${sym} ${card.rank}`);
    this.publish();
    return card;
  }

  private async damage(target: SeatState, n: number) {
    target.hp -= n;
    this.publish();
    await this.dyingProcess(target);
    await this.checkGameOver();
  }

  /** 濒死流程：从濒死者自己起，按座次顺位向持牌者求桃 */
  private async dyingProcess(target: SeatState) {
    while (target.hp <= 0 && !target.dead && !this.over) {
      this.io.log(`${target.name} 濒死（体力 ${target.hp}），向全场求【桃】`);
      this.publish();
      const order = this.seatOrderFrom(target.seat);
      let saved = false;
      for (const helper of order) {
        const canSelfJiu = helper.seat === target.seat;
        const hasCard = helper.hand.some(c => c.kind === "tao" || (canSelfJiu && c.kind === "jiu"));
        if (!hasCard) continue; // 简化：仅询问持牌者
        const id = await this.ask(helper.seat, "tao", null, target.seat);
        if (id === null) continue;
        const card = helper.hand.find(c => c.id === id);
        if (!card) continue;
        helper.hand = helper.hand.filter(c => c.id !== id);
        this.discard.push(card);
        target.hp = Math.min(target.maxHp, target.hp + 1);
        const selfNote = helper.seat === target.seat ? "自救" : `被 ${helper.name} 所救`;
        this.io.log(`${target.name} ${selfNote}（【${CARD_NAMES[card.kind]}】），体力回复至 ${target.hp}`);
        this.publish();
        if (target.hp > 0) { saved = true; break; }
      }
      if (!saved && target.hp <= 0) {
        target.dead = true;
        this.discard.push(...target.hand, ...(Object.values(target.equip).filter(Boolean) as Card[]));
        target.hand = [];
        target.equip = {};
        this.io.log(`${target.name} 阵亡`);
        this.publish();
        if (this.turnSeat === target.seat) this.endPlayPhase();
        break;
      }
    }
  }

  /** 从某座位开始按座次顺位返回存活座位 */
  private seatOrderFrom(seat: number): SeatState[] {
    const order = this.alive().map(x => x.seat).sort((a, b) => a - b);
    const i = order.indexOf(seat);
    const rotated = i >= 0 ? [...order.slice(i), ...order.slice(0, i)] : order;
    return rotated.map(x => this.bySeat(x)!).filter(Boolean);
  }

  private async checkGameOver() {
    const alive = this.alive();
    if (this.seats.length >= 2 && alive.length <= 1) {
      this.phase = "over";
      this.over = true;
      this.winner = alive[0]?.name ?? null;
      this.io.log(this.winner ? `对局结束：${this.winner} 获胜！` : "对局结束：无人存活");
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending = null;
      }
      this.endPlayPhase();
      this.io.broadcast("game.over", { reason: "win", winner: this.winner, state: this.publicState() });
    }
  }

  /* ---------------- 询问（闪 / 桃） ---------------- */

  private ask(seat: number, type: "shan" | "tao", fromSeat: number | null, dyingSeat?: number): Promise<number | null> {
    return new Promise(resolve => {
      const ms = type === "tao" ? ASK_DYING_MS : ASK_MS;
      const p: PendingAsk = {
        seat, type, fromSeat, dyingSeat,
        until: Date.now() + ms,
        timer: setTimeout(() => this.resolveAsk(null), ms),
        resolve: cardId => {
          clearTimeout(p.timer);
          resolve(cardId);
        },
      };
      this.pending = p;
      this.publish();
    });
  }

  private resolveAsk(cardId: number | null) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(cardId);
  }

  private async onRespond(playerId: string, data: Record<string, unknown>) {
    const s = this.seats.find(x => x.playerId === playerId);
    if (!s || !this.pending || this.pending.seat !== s.seat) throw new Error("no-pending");
    if (data.cardId === null || data.cardId === undefined) {
      this.io.log(`${s.name} 放弃响应`);
      this.resolveAsk(null);
      return;
    }
    const cardId = Number(data.cardId);
    const card = s.hand.find(c => c.id === cardId);
    const dyingSelf = this.pending.dyingSeat === s.seat;
    if (!card || !(card.kind === this.pending.type || (this.pending.type === "tao" && dyingSelf && card.kind === "jiu")))
      throw new Error("bad-response");
    this.resolveAsk(cardId);
  }

  /* ---------------- 状态广播 ---------------- */

  private publicState(): PublicGameState {
    const prompt: Prompt | null = this.pending
      ? { type: this.pending.type, seat: this.pending.seat, fromSeat: this.pending.fromSeat, dyingSeat: this.pending.dyingSeat, until: this.pending.until }
      : null;
    const actor = this.bySeat(this.turnSeat);
    return {
      players: this.seats.map<PlayerBrief>(s => {
        const isActor = !!actor && !actor.dead && s.seat !== actor.seat;
        const dist = actor && s.seat !== actor.seat ? this.distFrom(actor, s) : 0;
        return {
          seat: s.seat,
          id: s.playerId,
          name: s.name,
          hp: Math.max(0, s.hp),
          maxHp: s.maxHp,
          handCount: s.hand.length,
          dead: s.dead,
          dist: isActor ? dist : 0,
          inRange: isActor ? dist <= this.attackRange(actor!) : false,
          equip: this.equipView(s),
        };
      }),
      turnSeat: this.turnSeat,
      phase: this.phase === "over" ? "over" : "play",
      turnPhase: this.turnPhase,
      prompt,
      shaUsed: this.shaUsed,
      wineUsed: this.wineUsed,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      winner: this.winner,
    };
  }

  publish() {
    if (this.seats.length === 0) return;
    this.io.broadcast("game.state", this.publicState());
    for (const s of this.seats) {
      this.io.sendTo(s.playerId, "game.state.private", {
        hand: s.hand.map(c => ({ id: c.id, kind: c.kind, name: CARD_NAMES[c.kind], suit: c.suit, rank: c.rank })),
      });
    }
  }
}
