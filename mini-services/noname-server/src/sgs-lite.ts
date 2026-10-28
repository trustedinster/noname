/**
 * GameHost 实现：无名杀·轻量版（服务端权威托管）
 *
 * 规则（2~8 人开桌）：
 *  - 每人 4 体力；牌堆：杀 x24 / 闪 x18 / 桃 x12 / 无中生有 x6；起手摸 4
 *  - 回合：摸 2 → 出牌阶段（每回合限一张杀，需指定目标；无中生有摸 2；桃回 1 体力）→ 结束时弃牌至体力数
 *  - 被杀者可打出【闪】抵消；体力 ≤ 0 进入濒死，可用【桃】回 1 体力，救不回来则阵亡
 *  - 最后存活者获胜
 *
 * 响应均有服务端 8 秒超时，断线/超时视同放弃。
 * 这是接入正式引擎前的权威内核：对外接口（start/handleAction/removePlayer/dispose）
 * 与无名杀 headless 引擎约定一致，整包引擎替换此文件即可，大厅/房间/协议层零改动。
 */
import type { Card, CardKind, PublicGameState, PlayerBrief, Prompt } from "./protocol";
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
  dead: boolean;
}

interface PendingAsk {
  seat: number;
  type: "shan" | "tao";
  fromSeat: number | null;
  until: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (cardId: number | null) => void;
}

const ASK_MS = 8000;

export class SgsLiteHost {
  private roster: { id: string; name: string; seat: number }[] = [];
  private seats: SeatState[] = [];
  private deck: Card[] = [];
  private discard: Card[] = [];
  private nextCardId = 1;
  private turnSeat = 0;
  private shaUsed = false;
  private over = false;
  private winner: string | null = null;
  private phase: "idle" | "play" | "over" = "idle";
  private pending: PendingAsk | null = null;
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
      this.discard.push(...s.hand);
      s.hand = [];
      s.dead = true;
      this.io.log(`${s.name} 离开对局，判负`);
      if (this.pending?.seat === s.seat) this.resolveAsk(null);
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

    // 响应动作同步结算：它必须能解除正在等待响应的串行队列，否则会自我死锁
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
        if (card && card.kind === this.pending.type) {
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
      dead: false,
    }));
    for (const s of this.seats) s.hand = this.draw(4);
    this.turnSeat = this.seats[0].seat;
    this.shaUsed = false;
    this.over = false;
    this.winner = null;
    this.phase = "play";
    this.io.log("对局开始：起手摸 4，先手摸 2。每回合限一张【杀】");
    this.io.broadcast("game.start", {
      seats: this.seats.map(s => ({ seat: s.seat, playerId: s.playerId, name: s.name })),
    });
    this.turnDraw();
    this.publish();
  }

  private buildDeck(): Card[] {
    const spec: [CardKind, number][] = [["sha", 24], ["shan", 18], ["tao", 12], ["wuzhong", 6]];
    const cards: Card[] = [];
    for (const [kind, n] of spec)
      for (let i = 0; i < n; i++) cards.push({ id: this.nextCardId++, kind });
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

  /* ---------------- 回合与出牌 ---------------- */

  private turnDraw() {
    const s = this.bySeat(this.turnSeat);
    if (!s) return;
    this.shaUsed = false;
    s.hand.push(...this.draw(2));
    this.io.log(`轮到 ${s.name}，摸 2 张`);
  }

  private async dispatch(playerId: string, type: string, data: Record<string, unknown>) {
    if (type === "respond") return this.onRespond(playerId, data);

    const s = this.bySeat(this.turnSeat);
    if (!s || s.playerId !== playerId) throw new Error("not-your-turn");

    if (type === "end") return this.endTurn(s);
    if (type !== "play") throw new Error("bad-action");

    const cardId = Number(data.cardId);
    const idx = s.hand.findIndex(c => c.id === cardId);
    if (idx < 0) throw new Error("no-such-card");
    const card = s.hand[idx];

    switch (card.kind) {
      case "sha": {
        if (this.shaUsed) throw new Error("sha-used");
        const target = this.bySeat(Number(data.targetSeat));
        if (!target || target.dead || target.seat === s.seat) throw new Error("bad-target");
        s.hand.splice(idx, 1);
        this.discard.push(card);
        this.shaUsed = true;
        this.io.log(`${s.name} 对 ${target.name} 使用【杀】`);
        this.publish();
        await this.resolveSha(s, target);
        return;
      }
      case "wuzhong": {
        s.hand.splice(idx, 1);
        this.discard.push(card);
        s.hand.push(...this.draw(2));
        this.io.log(`${s.name} 使用【无中生有】，摸 2 张`);
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
      default:
        throw new Error("bad-card");
    }
  }

  private async resolveSha(source: SeatState, target: SeatState) {
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
    this.io.log(`${target.name} 未响应，受到 1 点伤害`);
    await this.damage(target, 1);
    this.publish();
  }

  private async damage(target: SeatState, n: number) {
    target.hp -= n;
    while (target.hp <= 0 && !target.dead) {
      this.io.log(`${target.name} 濒死，可自用【桃】`);
      this.publish();
      const taoId = await this.ask(target.seat, "tao", null);
      if (taoId === null) {
        target.dead = true;
        this.discard.push(...target.hand);
        target.hand = [];
        this.io.log(`${target.name} 阵亡`);
        break;
      }
      const card = target.hand.find(c => c.id === taoId);
      if (card?.kind === "tao") {
        target.hand = target.hand.filter(c => c.id !== taoId);
        this.discard.push(card);
        target.hp = Math.min(target.maxHp, target.hp + 1);
        this.io.log(`${target.name} 使用【桃】，回复至 ${target.hp} 体力`);
      } else {
        break;
      }
    }
    await this.checkGameOver();
  }

  private async endTurn(s: SeatState) {
    if (s.hand.length > s.hp) {
      const dropped = s.hand.slice(s.hp);
      this.discard.push(...dropped);
      s.hand = s.hand.slice(0, s.hp);
      this.io.log(`${s.name} 弃置 ${dropped.length} 张手牌`);
    }
    const order = this.alive().map(x => x.seat).sort((a, b) => a - b);
    this.turnSeat = order.find(x => x > s.seat) ?? order[0];
    this.shaUsed = false;
    this.turnDraw();
    this.publish();
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
      this.io.broadcast("game.over", { reason: "win", winner: this.winner, state: this.publicState() });
    }
  }

  /* ---------------- 询问（闪 / 桃） ---------------- */

  private ask(seat: number, type: "shan" | "tao", fromSeat: number | null): Promise<number | null> {
    return new Promise(resolve => {
      const p: PendingAsk = {
        seat,
        type,
        fromSeat,
        until: Date.now() + ASK_MS,
        timer: setTimeout(() => this.resolveAsk(null), ASK_MS),
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
    if (!card || card.kind !== this.pending.type) throw new Error("bad-response");
    this.resolveAsk(cardId);
  }

  /* ---------------- 状态广播 ---------------- */

  private publicState(): PublicGameState {
    const prompt: Prompt | null = this.pending
      ? { type: this.pending.type, seat: this.pending.seat, fromSeat: this.pending.fromSeat, until: this.pending.until }
      : null;
    return {
      players: this.seats.map<PlayerBrief>(s => ({
        seat: s.seat,
        id: s.playerId,
        name: s.name,
        hp: Math.max(0, s.hp),
        maxHp: s.maxHp,
        handCount: s.hand.length,
        dead: s.dead,
      })),
      turnSeat: this.turnSeat,
      phase: this.phase === "over" ? "over" : "play",
      prompt,
      shaUsed: this.shaUsed,
      discardCount: this.discard.length,
      winner: this.winner,
    };
  }

  publish() {
    if (this.seats.length === 0) return;
    this.io.broadcast("game.state", this.publicState());
    for (const s of this.seats) {
      this.io.sendTo(s.playerId, "game.state.private", {
        hand: s.hand.map(c => ({ id: c.id, kind: c.kind, name: CARD_NAMES[c.kind] })),
      });
    }
  }
}
