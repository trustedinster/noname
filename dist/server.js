"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_http = require("http");
var import_next = __toESM(require("next"));
var import_socket = require("socket.io");

// mini-services/noname-server/src/lobby.ts
var import_node_crypto = require("node:crypto");

// mini-services/noname-server/src/protocol.ts
var LIMITS = {
  name: 12,
  roomName: 20,
  maxMessageBytes: 16 * 1024,
  chat: 120,
  maxRooms: 100,
  maxPlayersPerRoom: 8,
  helloTimeoutMs: 8e3
};
var CARD_NAMES = {
  sha: "\u6740",
  shan: "\u95EA",
  tao: "\u6843",
  jiu: "\u9152",
  bagua: "\u516B\u5366\u9635",
  qinglong: "\u9752\u9F99\u5043\u6708\u5200",
  fangtian: "\u65B9\u5929\u753B\u621F",
  liannu: "\u8BF8\u845B\u8FDE\u5F29",
  horse_plus: "+1\u9A6C",
  horse_minus: "-1\u9A6C"
};

// mini-services/noname-server/src/sgs-lite.ts
var ASK_MS = 8e3;
var ASK_DYING_MS = 6e3;
var BASIC_SPEC = [
  ["sha", 30],
  ["shan", 22],
  ["tao", 12],
  ["jiu", 4]
];
var SUITS = ["spade", "heart", "club", "diamond"];
var EQUIP_SPEC = [
  { kind: "liannu", slot: "weapon", range: 1, suit: "diamond", rank: 1 },
  { kind: "qinglong", slot: "weapon", range: 3, suit: "spade", rank: 5 },
  { kind: "fangtian", slot: "weapon", range: 4, suit: "diamond", rank: 12 },
  { kind: "bagua", slot: "armor", suit: "spade", rank: 2 },
  { kind: "horse_plus", slot: "horse+", suit: "club", rank: 5 },
  { kind: "horse_plus", slot: "horse+", suit: "spade", rank: 5 },
  { kind: "horse_plus", slot: "horse+", suit: "heart", rank: 13 },
  { kind: "horse_minus", slot: "horse-", suit: "heart", rank: 5 },
  { kind: "horse_minus", slot: "horse-", suit: "spade", rank: 13 },
  { kind: "horse_minus", slot: "horse-", suit: "diamond", rank: 8 }
];
var KIND_TYPE = {
  sha: "basic",
  shan: "basic",
  tao: "basic",
  jiu: "basic",
  liannu: "equip",
  qinglong: "equip",
  fangtian: "equip",
  bagua: "equip",
  horse_plus: "equip",
  horse_minus: "equip"
};
var SgsLiteHost = class {
  constructor(io) {
    this.io = io;
    this.roster = [];
    this.seats = [];
    this.deck = [];
    this.discard = [];
    this.nextCardId = 1;
    this.turnSeat = 0;
    this.turnPhase = "prepare";
    this.shaUsed = false;
    this.wineUsed = false;
    /** 本回合是否已用酒增益（下一杀 +1 伤害） */
    this.wineBuff = false;
    this.over = false;
    this.winner = null;
    this.phase = "idle";
    this.pending = null;
    this.playResolve = null;
    this.queue = Promise.resolve();
  }
  /* ---------------- GameHost 接口 ---------------- */
  addPlayer(p) {
    if (this.phase === "play") return;
    if (this.roster.some((r) => r.id === p.id)) return;
    const used = new Set(this.roster.map((r) => r.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    this.roster.push({ id: p.id, name: p.name, seat });
  }
  removePlayer(playerId) {
    this.enqueue(async () => {
      this.roster = this.roster.filter((r) => r.id !== playerId);
      const s = this.seats.find((x) => x.playerId === playerId);
      if (!s || s.dead || this.phase !== "play") return;
      this.discard.push(...s.hand, ...Object.values(s.equip).filter(Boolean));
      s.hand = [];
      s.equip = {};
      s.dead = true;
      this.io.log(`${s.name} \u79BB\u5F00\u5BF9\u5C40\uFF0C\u5224\u8D1F`);
      if (this.pending?.seat === s.seat) this.resolveAsk(null);
      if (this.turnSeat === s.seat) this.endPlayPhase();
      await this.checkGameOver();
      this.publish();
    });
  }
  setReady(_playerId, _ready) {
  }
  maybeStart() {
    this.enqueue(async () => {
      if (this.phase === "play" || this.roster.length < 2) return;
      this.begin();
    });
  }
  handleAction(playerId, action) {
    const type = String(action?.type ?? "");
    if (type === "respond" && this.pending) {
      const s = this.seats.find((x) => x.playerId === playerId);
      if (s && this.pending.seat === s.seat) {
        const data = action?.data ?? {};
        if (data.cardId === null || data.cardId === void 0) {
          this.io.log(`${s.name} \u653E\u5F03\u54CD\u5E94`);
          this.resolveAsk(null);
          return;
        }
        const cardId = Number(data.cardId);
        const card = s.hand.find((c) => c.id === cardId);
        const dyingSelf = this.pending.dyingSeat === s.seat;
        const okKind = card && (card.kind === this.pending.type || this.pending.type === "tao" && dyingSelf && card.kind === "jiu");
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
      const data = action?.data ?? {};
      try {
        await this.dispatch(playerId, type, data);
      } catch (e) {
        this.io.sendTo(playerId, "game.event", {
          kind: "invalid",
          reason: e instanceof Error ? e.message : String(e)
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
  enqueue(fn) {
    this.queue = this.queue.then(fn, () => fn());
  }
  begin() {
    this.deck = this.buildDeck();
    this.discard = [];
    this.seats = this.roster.map((r) => ({
      seat: r.seat,
      playerId: r.id,
      name: r.name,
      hp: 4,
      maxHp: 4,
      hand: [],
      equip: {},
      dead: false
    }));
    for (const s of this.seats) s.hand = this.draw(4);
    this.turnSeat = this.seats[0].seat;
    this.shaUsed = false;
    this.wineUsed = false;
    this.wineBuff = false;
    this.over = false;
    this.winner = null;
    this.phase = "play";
    this.io.log("\u5BF9\u5C40\u5F00\u59CB\uFF1A\u8D77\u624B\u6478 4\u3002\u88C5\u5907\u724C\u6253\u51FA\u540E\u7F6E\u4E8E\u88C5\u5907\u533A\uFF0C\u4E0D\u5360\u624B\u724C\u4E0A\u9650");
    this.io.broadcast("game.start", {
      seats: this.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name }))
    });
    this.publish();
    void this.gameLoop();
  }
  buildDeck() {
    const cards = [];
    for (const [kind, n] of BASIC_SPEC) {
      for (let i = 0; i < n; i++) {
        cards.push({
          id: this.nextCardId++,
          kind,
          type: KIND_TYPE[kind],
          suit: SUITS[Math.floor(Math.random() * 4)],
          rank: 1 + Math.floor(Math.random() * 13)
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
        equip: { slot: e.slot, range: e.range }
      });
    }
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }
  draw(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) break;
        this.deck = this.discard;
        this.discard = [];
        for (let j = this.deck.length - 1; j > 0; j--) {
          const k = Math.floor(Math.random() * (j + 1));
          [this.deck[j], this.deck[k]] = [this.deck[k], this.deck[j]];
        }
        this.io.log("\u724C\u5806\u5DF2\u5C3D\uFF0C\u5F03\u724C\u5806\u6D17\u56DE");
      }
      const c = this.deck.pop();
      if (c) out.push(c);
    }
    return out;
  }
  bySeat(seat) {
    return this.seats.find((s) => s.seat === seat);
  }
  alive() {
    return this.seats.filter((s) => !s.dead);
  }
  /* ---------------- 回合循环与阶段机 ---------------- */
  async gameLoop() {
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
  nextAliveSeat(from) {
    const order = this.alive().map((x) => x.seat).sort((a, b) => a - b);
    return order.find((x) => x > from) ?? order[0];
  }
  setPhase(p) {
    this.turnPhase = p;
    this.publish();
  }
  async runTurn(s) {
    this.shaUsed = false;
    this.wineUsed = false;
    this.wineBuff = false;
    this.setPhase("prepare");
    this.io.log(`\u2014\u2014 ${s.name} \u7684\u56DE\u5408 \u2014\u2014`);
    this.setPhase("judgment");
    this.setPhase("draw");
    const drawn = this.draw(2);
    s.hand.push(...drawn);
    this.io.log(`${s.name} \u6478 2 \u5F20`);
    this.publish();
    this.turnPhase = "play";
    this.publish();
    await this.waitPlayDecision();
    if (this.over) return;
    this.setPhase("discard");
    if (s.hand.length > s.hp) {
      const dropped = s.hand.slice(s.hp);
      this.discard.push(...dropped);
      s.hand = s.hand.slice(0, s.hp);
      this.io.log(`${s.name} \u5F03\u7F6E ${dropped.length} \u5F20\u624B\u724C\uFF08\u624B\u724C\u4E0A\u9650 = \u4F53\u529B\uFF09`);
    }
    this.publish();
    this.setPhase("finish");
  }
  waitPlayDecision() {
    return new Promise((res) => {
      this.playResolve = res;
    });
  }
  endPlayPhase() {
    const r = this.playResolve;
    this.playResolve = null;
    r?.();
  }
  /* ---------------- 距离与装备 ---------------- */
  ringDist(a, b) {
    const order = this.alive().map((x) => x.seat).sort((x, y) => x - y);
    const ia = order.indexOf(a), ib = order.indexOf(b);
    const n = order.length;
    if (ia < 0 || ib < 0 || n === 0) return 99;
    return Math.min((ib - ia + n) % n, (ia - ib + n) % n);
  }
  /** from 视角到 to 的距离（含坐骑修正，最小 1） */
  distFrom(from, to) {
    let d = this.ringDist(from.seat, to.seat);
    if (from.equip["horse-"]) d -= 1;
    if (to.equip["horse+"]) d += 1;
    return Math.max(1, d);
  }
  attackRange(s) {
    return s.equip.weapon?.equip?.range ?? 1;
  }
  equipView(s) {
    return Object.entries(s.equip).filter(([, c]) => Boolean(c)).map(([slot, c]) => ({ slot, kind: c.kind, name: CARD_NAMES[c.kind], suit: c.suit, rank: c.rank }));
  }
  /* ---------------- 出牌 ---------------- */
  async dispatch(playerId, type, data) {
    if (type === "respond") return this.onRespond(playerId, data);
    const s = this.bySeat(this.turnSeat);
    if (!s || s.playerId !== playerId) throw new Error("not-your-turn");
    if (this.turnPhase !== "play") throw new Error("not-play-phase");
    if (type === "end") {
      this.io.log(`${s.name} \u7ED3\u675F\u51FA\u724C\u9636\u6BB5`);
      this.endPlayPhase();
      return;
    }
    if (type !== "play") throw new Error("bad-action");
    const cardId = Number(data.cardId);
    const idx = s.hand.findIndex((c) => c.id === cardId);
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
        const wineNote = this.wineBuff ? "\uFF08\u9152\u540E\u4F24\u5BB3 +1\uFF09" : "";
        this.io.log(`${s.name} \u5BF9 ${target.name} \u4F7F\u7528\u3010\u6740\u3011${wineNote}`);
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
        this.io.log(`${s.name} \u4F7F\u7528\u3010\u9152\u3011\uFF1A\u672C\u56DE\u5408\u4E0B\u4E00\u5F20\u3010\u6740\u3011\u4F24\u5BB3 +1`);
        this.publish();
        return;
      }
      case "tao": {
        if (s.hp >= s.maxHp) throw new Error("hp-full");
        s.hand.splice(idx, 1);
        this.discard.push(card);
        s.hp = Math.min(s.maxHp, s.hp + 1);
        this.io.log(`${s.name} \u4F7F\u7528\u3010\u6843\u3011\uFF0C\u56DE\u590D\u81F3 ${s.hp} \u4F53\u529B`);
        this.publish();
        return;
      }
      case "bagua":
      case "liannu":
      case "qinglong":
      case "fangtian":
      case "horse_plus":
      case "horse_minus": {
        const slot = card.equip.slot;
        const old = s.equip[slot];
        s.hand.splice(idx, 1);
        s.equip[slot] = card;
        if (old) this.discard.push(old);
        this.io.log(`${s.name} \u88C5\u5907\u4E86\u3010${CARD_NAMES[card.kind]}\u3011${old ? `\uFF08\u66FF\u6362\u3010${CARD_NAMES[old.kind]}\u3011\uFF09` : ""}`);
        this.publish();
        return;
      }
      case "shan":
      default:
        throw new Error("card-not-playable");
    }
  }
  async resolveSha(source, target, dmg) {
    if (target.equip.armor?.kind === "bagua") {
      const j = await this.judge(target, "\u516B\u5366\u9635");
      if (j.suit === "heart" || j.suit === "diamond") {
        this.io.log(`${target.name} \u7684\u3010\u516B\u5366\u9635\u3011\u5224\u5B9A\u4E3A\u7EA2\u8272\uFF0C\u89C6\u4E3A\u6253\u51FA\u3010\u95EA\u3011`);
        this.publish();
        return;
      }
      this.io.log(`${target.name} \u7684\u3010\u516B\u5366\u9635\u3011\u5224\u5B9A\u4E3A\u9ED1\u8272\uFF0C\u4ECD\u9700\u6253\u51FA\u3010\u95EA\u3011`);
    }
    const dodgeId = await this.ask(target.seat, "shan", source.seat);
    if (dodgeId !== null) {
      const card = target.hand.find((c) => c.id === dodgeId);
      if (card?.kind === "shan") {
        target.hand = target.hand.filter((c) => c.id !== dodgeId);
        this.discard.push(card);
        this.io.log(`${target.name} \u6253\u51FA\u3010\u95EA\u3011\uFF0C\u62B5\u6D88\u4E86\u3010\u6740\u3011`);
        this.publish();
        return;
      }
    }
    this.io.log(`${target.name} \u672A\u54CD\u5E94\uFF0C\u53D7\u5230 ${dmg} \u70B9\u4F24\u5BB3`);
    await this.damage(target, dmg);
    this.publish();
  }
  /** 从牌堆顶翻开一张判定牌（进弃牌堆） */
  async judge(who, reason) {
    const [card] = this.draw(1);
    if (!card) throw new Error("deck-empty");
    this.discard.push(card);
    const sym = card.suit === "spade" || card.suit === "club" ? "\u9ED1" : "\u7EA2";
    this.io.log(`${who.name} \u8FDB\u884C\u3010${reason}\u3011\u5224\u5B9A\uFF1A${sym} ${card.rank}`);
    this.publish();
    return card;
  }
  async damage(target, n) {
    target.hp -= n;
    this.publish();
    await this.dyingProcess(target);
    await this.checkGameOver();
  }
  /** 濒死流程：从濒死者自己起，按座次顺位向持牌者求桃 */
  async dyingProcess(target) {
    while (target.hp <= 0 && !target.dead && !this.over) {
      this.io.log(`${target.name} \u6FD2\u6B7B\uFF08\u4F53\u529B ${target.hp}\uFF09\uFF0C\u5411\u5168\u573A\u6C42\u3010\u6843\u3011`);
      this.publish();
      const order = this.seatOrderFrom(target.seat);
      let saved = false;
      for (const helper of order) {
        const canSelfJiu = helper.seat === target.seat;
        const hasCard = helper.hand.some((c) => c.kind === "tao" || canSelfJiu && c.kind === "jiu");
        if (!hasCard) continue;
        const id = await this.ask(helper.seat, "tao", null, target.seat);
        if (id === null) continue;
        const card = helper.hand.find((c) => c.id === id);
        if (!card) continue;
        helper.hand = helper.hand.filter((c) => c.id !== id);
        this.discard.push(card);
        target.hp = Math.min(target.maxHp, target.hp + 1);
        const selfNote = helper.seat === target.seat ? "\u81EA\u6551" : `\u88AB ${helper.name} \u6240\u6551`;
        this.io.log(`${target.name} ${selfNote}\uFF08\u3010${CARD_NAMES[card.kind]}\u3011\uFF09\uFF0C\u4F53\u529B\u56DE\u590D\u81F3 ${target.hp}`);
        this.publish();
        if (target.hp > 0) {
          saved = true;
          break;
        }
      }
      if (!saved && target.hp <= 0) {
        target.dead = true;
        this.discard.push(...target.hand, ...Object.values(target.equip).filter(Boolean));
        target.hand = [];
        target.equip = {};
        this.io.log(`${target.name} \u9635\u4EA1`);
        this.publish();
        if (this.turnSeat === target.seat) this.endPlayPhase();
        break;
      }
    }
  }
  /** 从某座位开始按座次顺位返回存活座位 */
  seatOrderFrom(seat) {
    const order = this.alive().map((x) => x.seat).sort((a, b) => a - b);
    const i = order.indexOf(seat);
    const rotated = i >= 0 ? [...order.slice(i), ...order.slice(0, i)] : order;
    return rotated.map((x) => this.bySeat(x)).filter(Boolean);
  }
  async checkGameOver() {
    const alive = this.alive();
    if (this.seats.length >= 2 && alive.length <= 1) {
      this.phase = "over";
      this.over = true;
      this.winner = alive[0]?.name ?? null;
      this.io.log(this.winner ? `\u5BF9\u5C40\u7ED3\u675F\uFF1A${this.winner} \u83B7\u80DC\uFF01` : "\u5BF9\u5C40\u7ED3\u675F\uFF1A\u65E0\u4EBA\u5B58\u6D3B");
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending = null;
      }
      this.endPlayPhase();
      this.io.broadcast("game.over", { reason: "win", winner: this.winner, state: this.publicState() });
    }
  }
  /* ---------------- 询问（闪 / 桃） ---------------- */
  ask(seat, type, fromSeat, dyingSeat) {
    return new Promise((resolve) => {
      const ms = type === "tao" ? ASK_DYING_MS : ASK_MS;
      const p = {
        seat,
        type,
        fromSeat,
        dyingSeat,
        until: Date.now() + ms,
        timer: setTimeout(() => this.resolveAsk(null), ms),
        resolve: (cardId) => {
          clearTimeout(p.timer);
          resolve(cardId);
        }
      };
      this.pending = p;
      this.publish();
    });
  }
  resolveAsk(cardId) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(cardId);
  }
  async onRespond(playerId, data) {
    const s = this.seats.find((x) => x.playerId === playerId);
    if (!s || !this.pending || this.pending.seat !== s.seat) throw new Error("no-pending");
    if (data.cardId === null || data.cardId === void 0) {
      this.io.log(`${s.name} \u653E\u5F03\u54CD\u5E94`);
      this.resolveAsk(null);
      return;
    }
    const cardId = Number(data.cardId);
    const card = s.hand.find((c) => c.id === cardId);
    const dyingSelf = this.pending.dyingSeat === s.seat;
    if (!card || !(card.kind === this.pending.type || this.pending.type === "tao" && dyingSelf && card.kind === "jiu"))
      throw new Error("bad-response");
    this.resolveAsk(cardId);
  }
  /* ---------------- 状态广播 ---------------- */
  publicState() {
    const prompt = this.pending ? { type: this.pending.type, seat: this.pending.seat, fromSeat: this.pending.fromSeat, dyingSeat: this.pending.dyingSeat, until: this.pending.until } : null;
    const actor = this.bySeat(this.turnSeat);
    return {
      players: this.seats.map((s) => {
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
          inRange: isActor ? dist <= this.attackRange(actor) : false,
          equip: this.equipView(s)
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
      winner: this.winner
    };
  }
  publish() {
    if (this.seats.length === 0) return;
    this.io.broadcast("game.state", this.publicState());
    for (const s of this.seats) {
      this.io.sendTo(s.playerId, "game.state.private", {
        hand: s.hand.map((c) => ({ id: c.id, kind: c.kind, name: CARD_NAMES[c.kind], suit: c.suit, rank: c.rank }))
      });
    }
  }
};

// mini-services/noname-server/src/lobby.ts
var Room = class {
  constructor(name, lobby) {
    this.lobby = lobby;
    this.members = /* @__PURE__ */ new Map();
    this.id = (0, import_node_crypto.randomUUID)().slice(0, 8);
    this.name = name;
    this.host = new SgsLiteHost({
      broadcast: (t, d) => this.broadcast(t, d),
      sendTo: (pid, t, d) => this.sendTo(pid, t, d),
      log: (text) => this.broadcast("game.log", { text, ts: Date.now() })
    });
  }
  get over() {
    return false;
  }
  join(member) {
    this.members.set(member.id, member);
    this.host.addPlayer({ id: member.id, name: member.name });
    this.broadcastRoomState();
    this.lobby.broadcastLobby();
  }
  leave(playerId) {
    if (!this.members.delete(playerId)) return;
    this.host.removePlayer(playerId);
    if (this.members.size === 0) {
      this.host.dispose();
      this.lobby.rooms.delete(this.id);
    } else {
      this.broadcastRoomState();
    }
    this.lobby.broadcastLobby();
  }
  setReady(playerId, ready) {
    const m = this.members.get(playerId);
    if (!m) return;
    m.ready = ready;
    this.host.setReady(playerId, ready);
    this.broadcastRoomState();
    this.host.maybeStart();
  }
  chat(from, text) {
    this.broadcast("room.chat", { from: from.name, text, ts: Date.now() });
  }
  handleGameAction(playerId, action) {
    this.host.handleAction(playerId, action);
  }
  broadcast(t, d) {
    if (t === "game.over") {
      for (const m of this.members.values()) m.ready = false;
      this.broadcastRoomState();
    }
    for (const m of this.members.values()) {
      if (m.socket.connected) m.socket.emit("evt", { t, d });
    }
  }
  sendTo(playerId, t, d) {
    const m = this.members.get(playerId);
    if (m?.socket.connected) m.socket.emit("evt", { t, d });
  }
  summary() {
    return {
      id: this.id,
      name: this.name,
      game: "sgs-lite",
      players: this.members.size,
      max: LIMITS.maxPlayersPerRoom,
      started: this.members.size > 0 && [...this.members.values()].every((m) => m.ready) && this.members.size >= 2,
      over: this.over
    };
  }
  roomState() {
    return {
      id: this.id,
      name: this.name,
      game: "sgs-lite",
      members: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, ready: m.ready })),
      started: this.summary().started,
      over: this.over
    };
  }
  broadcastRoomState() {
    this.broadcast("room.state", this.roomState());
  }
};
var Lobby = class {
  constructor() {
    this.players = /* @__PURE__ */ new Map();
    this.rooms = /* @__PURE__ */ new Map();
  }
  onConnection(socket) {
    let player = null;
    const helloTimer = setTimeout(() => {
      if (!player) socket.disconnect(true);
    }, LIMITS.helloTimeoutMs);
    socket.on("msg", (raw) => {
      if (typeof raw === "string" && raw.length > LIMITS.maxMessageBytes) {
        socket.disconnect(true);
        return;
      }
      const msg = this.decode(raw);
      if (!msg) {
        socket.emit("ack", { seq: raw?.seq, ok: false, d: { code: "bad-envelope" } });
        return;
      }
      try {
        switch (msg.t) {
          case "hello": {
            const name = String(msg.d?.name ?? "\u65E0\u540D\u73A9\u5BB6").slice(0, LIMITS.name) || "\u65E0\u540D\u73A9\u5BB6";
            player = { id: socket.id, name, socket, roomId: null };
            this.players.set(socket.id, player);
            clearTimeout(helloTimer);
            socket.emit("ack", { seq: msg.seq, ok: true, d: { id: socket.id, name } });
            socket.emit("evt", { t: "lobby.state", d: { rooms: this.roomSummaries(), online: this.players.size } });
            break;
          }
          case "lobby.refresh": {
            const d = { rooms: this.roomSummaries(), online: this.players.size };
            socket.emit("ack", { seq: msg.seq, ok: true, d });
            socket.emit("evt", { t: "lobby.state", d });
            break;
          }
          case "room.create": {
            if (!player) throw new Error("not-hello");
            if (this.rooms.size >= LIMITS.maxRooms) throw new Error("rooms-full");
            const name = String(msg.d?.name ?? "\u65B0\u623F\u95F4").slice(0, LIMITS.roomName) || "\u65B0\u623F\u95F4";
            const room = new Room(name, this);
            this.rooms.set(room.id, room);
            room.join({ id: player.id, name: player.name, ready: false, socket });
            player.roomId = room.id;
            socket.emit("ack", { seq: msg.seq, ok: true, d: { roomId: room.id } });
            socket.emit("evt", { t: "room.joined", d: room.roomState() });
            break;
          }
          case "room.join": {
            if (!player) throw new Error("not-hello");
            const room = this.rooms.get(String(msg.d?.roomId ?? ""));
            if (!room) throw new Error("no-such-room");
            room.join({ id: player.id, name: player.name, ready: false, socket });
            player.roomId = room.id;
            socket.emit("ack", { seq: msg.seq, ok: true });
            socket.emit("evt", { t: "room.joined", d: room.roomState() });
            break;
          }
          case "room.leave": {
            if (player?.roomId) {
              this.rooms.get(player.roomId)?.leave(player.id);
              player.roomId = null;
            }
            socket.emit("ack", { seq: msg.seq, ok: true });
            break;
          }
          case "room.ready": {
            if (player?.roomId) this.rooms.get(player.roomId)?.setReady(player.id, !!msg.d?.ready);
            socket.emit("ack", { seq: msg.seq, ok: true });
            break;
          }
          case "room.chat": {
            if (player?.roomId) {
              const room = this.rooms.get(player.roomId);
              const m = room?.members.get(player.id);
              if (room && m) room.chat(m, String(msg.d?.text ?? "").slice(0, LIMITS.chat));
            }
            socket.emit("ack", { seq: msg.seq, ok: true });
            break;
          }
          case "game.action": {
            if (player?.roomId) this.rooms.get(player.roomId)?.handleGameAction(player.id, msg.d);
            socket.emit("ack", { seq: msg.seq, ok: true });
            break;
          }
          case "ping": {
            socket.emit("ack", { seq: msg.seq, ok: true, d: { ts: Date.now() } });
            break;
          }
          default: {
            socket.emit("ack", { seq: msg.seq, ok: false, d: { code: "unknown-type" } });
          }
        }
      } catch (e) {
        socket.emit("ack", {
          seq: msg.seq,
          ok: false,
          d: { code: e instanceof Error ? e.message : "error", message: e instanceof Error ? e.message : "\u670D\u52A1\u7AEF\u9519\u8BEF" }
        });
      }
    });
    socket.on("disconnect", () => {
      clearTimeout(helloTimer);
      if (player) {
        if (player.roomId) this.rooms.get(player.roomId)?.leave(player.id);
        this.players.delete(player.id);
        this.broadcastLobby();
      }
    });
  }
  decode(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const msg = raw;
    if (typeof msg.t !== "string") return null;
    if (msg.seq !== void 0 && typeof msg.seq !== "number") return null;
    if (msg.d !== void 0 && (typeof msg.d !== "object" || msg.d === null)) return null;
    return msg;
  }
  roomSummaries() {
    return [...this.rooms.values()].map((r) => r.summary());
  }
  broadcastLobby() {
    const d = { rooms: this.roomSummaries(), online: this.players.size };
    for (const p of this.players.values()) {
      if (!p.roomId && p.socket.connected) p.socket.emit("evt", { t: "lobby.state", d });
    }
  }
  stop() {
    for (const p of this.players.values()) p.socket.disconnect(true);
  }
};

// server.ts
var dev = process.argv.includes("--dev");
var port = Number(process.env.PORT) || 3e3;
async function main() {
  const app = (0, import_next.default)({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();
  const httpServer = (0, import_http.createServer)((req, res) => {
    handle(req, res);
  });
  const io = new import_socket.Server(httpServer, {
    path: "/socket.io",
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 6e4,
    pingInterval: 25e3,
    maxHttpBufferSize: 16 * 1024
  });
  const lobby = new Lobby();
  io.on("connection", (socket) => lobby.onConnection(socket));
  httpServer.listen(port, () => {
    console.log(
      `[noname] \u5355\u8FDB\u7A0B\u8FD0\u884C\u4E8E :${port}\uFF08Next \u9875\u9762 + socket.io /socket.io\uFF09\uFF0Cdev=${dev}`
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
