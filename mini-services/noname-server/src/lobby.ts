/**
 * 大厅 + 房间：从独立版 noname-server 迁移，传输层换成 socket.io。
 * 房间持有一个 GameHost（服务端权威托管）。
 */
import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { SgsLiteHost } from "./sgs-lite";
import { modeFor } from "./modes";
import { LIMITS, type RoomState, type RoomSummary } from "./protocol";

interface Member {
  id: string;
  name: string;
  ready: boolean;
  socket: Socket;
}

export class Room {
  readonly id: string;
  name: string;
  members = new Map<string, Member>();
  private host: SgsLiteHost;

  constructor(
    name: string,
    private lobby: Lobby
  ) {
    this.id = randomUUID().slice(0, 8);
    this.name = name;
    this.host = new SgsLiteHost({
      broadcast: (t, d) => this.broadcast(t, d),
      sendTo: (pid, t, d) => this.sendTo(pid, t, d),
      log: text => this.broadcast("game.log", { text, ts: Date.now() }),
    });
  }

  get over() {
    return false; // 房间常驻，游戏结束可再来一局
  }

  join(member: Member) {
    this.members.set(member.id, member);
    this.host.addPlayer({ id: member.id, name: member.name });
    this.broadcastRoomState();
    this.lobby.broadcastLobby();
  }

  leave(playerId: string) {
    if (!this.members.delete(playerId)) return;
    this.host.removePlayer(playerId);
    if (this.members.size === 0) {
      // 空房间自动注销，避免死房堆积
      this.host.dispose();
      this.lobby.rooms.delete(this.id);
    } else {
      this.broadcastRoomState();
    }
    this.lobby.broadcastLobby();
  }

  setReady(playerId: string, ready: boolean) {
    const m = this.members.get(playerId);
    if (!m) return;
    m.ready = ready;
    this.host.setReady(playerId, ready);
    this.broadcastRoomState();
    this.host.maybeStart();
  }

  chat(from: Member, text: string) {
    this.broadcast("room.chat", { from: from.name, text, ts: Date.now() });
  }

  handleGameAction(playerId: string, action: unknown) {
    this.host.handleAction(playerId, action as { type?: unknown; data?: unknown });
  }

  broadcast(t: string, d: unknown) {
    if (t === "game.over") {
      // 一局结束后重置准备状态，全员重新准备即可再开一局
      for (const m of this.members.values()) m.ready = false;
      this.broadcastRoomState();
    }
    for (const m of this.members.values()) {
      if (m.socket.connected) m.socket.emit("evt", { t, d });
    }
  }

  sendTo(playerId: string, t: string, d: unknown) {
    const m = this.members.get(playerId);
    if (m?.socket.connected) m.socket.emit("evt", { t, d });
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.name,
      game: "sgs-lite",
      mode: modeFor(this.members.size)?.name ?? "—",
      players: this.members.size,
      max: LIMITS.maxPlayersPerRoom,
      started: this.members.size > 0 && [...this.members.values()].every(m => m.ready) && this.members.size >= 2,
      over: this.over,
    };
  }

  roomState(): RoomState {
    const mode = modeFor(this.members.size);
    return {
      id: this.id,
      name: this.name,
      game: "sgs-lite",
      mode: mode?.name ?? "暂无模式",
      modeUnavailable: !mode,
      members: [...this.members.values()].map(m => ({ id: m.id, name: m.name, ready: m.ready })),
      started: this.summary().started,
      over: this.over,
    };
  }

  broadcastRoomState() {
    this.broadcast("room.state", this.roomState());
  }
}

export class Lobby {
  players = new Map<string, { id: string; name: string; socket: Socket; roomId: string | null }>();
  rooms = new Map<string, Room>();

  onConnection(socket: Socket) {
    let player: { id: string; name: string; socket: Socket; roomId: string | null } | null = null;
    const helloTimer = setTimeout(() => {
      if (!player) socket.disconnect(true);
    }, LIMITS.helloTimeoutMs);

    socket.on("msg", (raw: unknown) => {
      if (typeof raw === "string" && raw.length > LIMITS.maxMessageBytes) {
        socket.disconnect(true);
        return;
      }
      const msg = this.decode(raw);
      if (!msg) {
        socket.emit("ack", { seq: (raw as { seq?: number })?.seq, ok: false, d: { code: "bad-envelope" } });
        return;
      }

      try {
        switch (msg.t) {
          case "hello": {
            const name = String(msg.d?.name ?? "无名玩家").slice(0, LIMITS.name) || "无名玩家";
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
            const name = String(msg.d?.name ?? "新房间").slice(0, LIMITS.roomName) || "新房间";
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
          d: { code: e instanceof Error ? e.message : "error", message: e instanceof Error ? e.message : "服务端错误" },
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

  private decode(raw: unknown): { t: string; seq?: number; d?: Record<string, unknown> } | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const msg = raw as Record<string, unknown>;
    if (typeof msg.t !== "string") return null;
    if (msg.seq !== undefined && typeof msg.seq !== "number") return null;
    if (msg.d !== undefined && (typeof msg.d !== "object" || msg.d === null)) return null;
    return msg as { t: string; seq?: number; d?: Record<string, unknown> };
  }

  roomSummaries(): RoomSummary[] {
    return [...this.rooms.values()].map(r => r.summary());
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
}
