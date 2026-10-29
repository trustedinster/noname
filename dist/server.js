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
  wuzhong: "\u65E0\u4E2D\u751F\u6709"
};

// mini-services/noname-server/src/sgs-lite.ts
var ASK_MS = 8e3;
var SgsLiteHost = class {
  constructor(io) {
    this.io = io;
    this.roster = [];
    this.seats = [];
    this.deck = [];
    this.discard = [];
    this.nextCardId = 1;
    this.turnSeat = 0;
    this.shaUsed = false;
    this.over = false;
    this.winner = null;
    this.phase = "idle";
    this.pending = null;
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
      this.discard.push(...s.hand);
      s.hand = [];
      s.dead = true;
      this.io.log(`${s.name} \u79BB\u5F00\u5BF9\u5C40\uFF0C\u5224\u8D1F`);
      if (this.pending?.seat === s.seat) this.resolveAsk(null);
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
      dead: false
    }));
    for (const s of this.seats) s.hand = this.draw(4);
    this.turnSeat = this.seats[0].seat;
    this.shaUsed = false;
    this.over = false;
    this.winner = null;
    this.phase = "play";
    this.io.log("\u5BF9\u5C40\u5F00\u59CB\uFF1A\u8D77\u624B\u6478 4\uFF0C\u5148\u624B\u6478 2\u3002\u6BCF\u56DE\u5408\u9650\u4E00\u5F20\u3010\u6740\u3011");
    this.io.broadcast("game.start", {
      seats: this.seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name }))
    });
    this.turnDraw();
    this.publish();
  }
  buildDeck() {
    const spec = [["sha", 24], ["shan", 18], ["tao", 12], ["wuzhong", 6]];
    const cards = [];
    for (const [kind, n] of spec)
      for (let i = 0; i < n; i++) cards.push({ id: this.nextCardId++, kind });
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
  /* ---------------- 回合与出牌 ---------------- */
  turnDraw() {
    const s = this.bySeat(this.turnSeat);
    if (!s) return;
    this.shaUsed = false;
    s.hand.push(...this.draw(2));
    this.io.log(`\u8F6E\u5230 ${s.name}\uFF0C\u6478 2 \u5F20`);
  }
  async dispatch(playerId, type, data) {
    if (type === "respond") return this.onRespond(playerId, data);
    const s = this.bySeat(this.turnSeat);
    if (!s || s.playerId !== playerId) throw new Error("not-your-turn");
    if (type === "end") return this.endTurn(s);
    if (type !== "play") throw new Error("bad-action");
    const cardId = Number(data.cardId);
    const idx = s.hand.findIndex((c) => c.id === cardId);
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
        this.io.log(`${s.name} \u5BF9 ${target.name} \u4F7F\u7528\u3010\u6740\u3011`);
        this.publish();
        await this.resolveSha(s, target);
        return;
      }
      case "wuzhong": {
        s.hand.splice(idx, 1);
        this.discard.push(card);
        s.hand.push(...this.draw(2));
        this.io.log(`${s.name} \u4F7F\u7528\u3010\u65E0\u4E2D\u751F\u6709\u3011\uFF0C\u6478 2 \u5F20`);
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
      default:
        throw new Error("bad-card");
    }
  }
  async resolveSha(source, target) {
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
    this.io.log(`${target.name} \u672A\u54CD\u5E94\uFF0C\u53D7\u5230 1 \u70B9\u4F24\u5BB3`);
    await this.damage(target, 1);
    this.publish();
  }
  async damage(target, n) {
    target.hp -= n;
    while (target.hp <= 0 && !target.dead) {
      this.io.log(`${target.name} \u6FD2\u6B7B\uFF0C\u53EF\u81EA\u7528\u3010\u6843\u3011`);
      this.publish();
      const taoId = await this.ask(target.seat, "tao", null);
      if (taoId === null) {
        target.dead = true;
        this.discard.push(...target.hand);
        target.hand = [];
        this.io.log(`${target.name} \u9635\u4EA1`);
        break;
      }
      const card = target.hand.find((c) => c.id === taoId);
      if (card?.kind === "tao") {
        target.hand = target.hand.filter((c) => c.id !== taoId);
        this.discard.push(card);
        target.hp = Math.min(target.maxHp, target.hp + 1);
        this.io.log(`${target.name} \u4F7F\u7528\u3010\u6843\u3011\uFF0C\u56DE\u590D\u81F3 ${target.hp} \u4F53\u529B`);
      } else {
        break;
      }
    }
    await this.checkGameOver();
  }
  async endTurn(s) {
    if (s.hand.length > s.hp) {
      const dropped = s.hand.slice(s.hp);
      this.discard.push(...dropped);
      s.hand = s.hand.slice(0, s.hp);
      this.io.log(`${s.name} \u5F03\u7F6E ${dropped.length} \u5F20\u624B\u724C`);
    }
    const order = this.alive().map((x) => x.seat).sort((a, b) => a - b);
    this.turnSeat = order.find((x) => x > s.seat) ?? order[0];
    this.shaUsed = false;
    this.turnDraw();
    this.publish();
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
      this.io.broadcast("game.over", { reason: "win", winner: this.winner, state: this.publicState() });
    }
  }
  /* ---------------- 询问（闪 / 桃） ---------------- */
  ask(seat, type, fromSeat) {
    return new Promise((resolve) => {
      const p = {
        seat,
        type,
        fromSeat,
        until: Date.now() + ASK_MS,
        timer: setTimeout(() => this.resolveAsk(null), ASK_MS),
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
    if (!card || card.kind !== this.pending.type) throw new Error("bad-response");
    this.resolveAsk(cardId);
  }
  /* ---------------- 状态广播 ---------------- */
  publicState() {
    const prompt = this.pending ? { type: this.pending.type, seat: this.pending.seat, fromSeat: this.pending.fromSeat, until: this.pending.until } : null;
    return {
      players: this.seats.map((s) => ({
        seat: s.seat,
        id: s.playerId,
        name: s.name,
        hp: Math.max(0, s.hp),
        maxHp: s.maxHp,
        handCount: s.hand.length,
        dead: s.dead
      })),
      turnSeat: this.turnSeat,
      phase: this.phase === "over" ? "over" : "play",
      prompt,
      shaUsed: this.shaUsed,
      discardCount: this.discard.length,
      winner: this.winner
    };
  }
  publish() {
    if (this.seats.length === 0) return;
    this.io.broadcast("game.state", this.publicState());
    for (const s of this.seats) {
      this.io.sendTo(s.playerId, "game.state.private", {
        hand: s.hand.map((c) => ({ id: c.id, kind: c.kind, name: CARD_NAMES[c.kind] }))
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
