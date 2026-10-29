'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NonameClient, type Evt } from '@/lib/noname-client';

/* ---------- 类型（与服务端协议 v1.1 对应） ---------- */

type Suit = 'spade' | 'heart' | 'club' | 'diamond';
type CardKind =
  | 'sha' | 'shan' | 'tao' | 'jiu'
  | 'bagua' | 'qinglong' | 'fangtian' | 'liannu'
  | 'horse_plus' | 'horse_minus';
type EquipSlot = 'weapon' | 'armor' | 'horse+' | 'horse-';
type Card = { id: number; kind: CardKind; name: string; suit: Suit; rank: number };
type EquipView = { slot: EquipSlot; kind: CardKind; name: string; suit: Suit; rank: number };
type PlayerBrief = {
  seat: number; id: string; name: string;
  hp: number; maxHp: number; handCount: number; dead: boolean;
  dist: number; inRange: boolean; equip: EquipView[];
};
type GameState = {
  players: PlayerBrief[];
  turnSeat: number;
  phase: 'play' | 'over';
  turnPhase: TurnPhase;
  prompt: { type: 'shan' | 'tao'; seat: number; fromSeat: number | null; dyingSeat?: number; until: number } | null;
  shaUsed: boolean;
  wineUsed: boolean;
  deckCount: number;
  discardCount: number;
  winner: string | null;
};
type TurnPhase = 'prepare' | 'judgment' | 'draw' | 'play' | 'discard' | 'finish';
type Seat = { id: string; name: string };

/* ---------- 大厅 API 信封 ---------- */

type RoomSummary = { id: string; name: string; game: string; players: number; max: number; started: boolean; over: boolean };
type RoomState = { id: string; name: string; game: string; members: { id: string; name: string; ready: boolean }[]; started: boolean; over: boolean };

const SUIT_CHAR: Record<Suit, string> = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
const isRed = (s: Suit) => s === 'heart' || s === 'diamond';
const RANK_LABEL = (r: number) => (r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r));
const PHASE_LABEL: Record<TurnPhase, string> = { prepare: '准备', judgment: '判定', draw: '摸牌', play: '出牌', discard: '弃牌', finish: '结束' };
const EQUIP_ICON: Record<EquipSlot, string> = { weapon: '⚔', armor: '🛡', 'horse+': '＋马', 'horse-': '－马' };

/* ---------- 牌面（原版风格：纸底 + 角标花色点数 + 竖排牌名） ---------- */

function CardFace({ card, selected, onClick }: { card: Card; selected?: boolean; onClick?: () => void }) {
  const red = isRed(card.suit);
  return (
    <button
      onClick={onClick}
      className={`playing-card relative w-[76px] h-[110px] shrink-0 rounded-lg border shadow-lg select-none transition-all duration-150 ${red ? 'text-red-700' : 'text-stone-900'} ${
        selected ? '-translate-y-5 ring-2 ring-amber-400 shadow-amber-500/40' : 'hover:-translate-y-2'
      }`}
    >
      <span className="absolute top-0.5 left-1.5 text-[13px] leading-tight font-bold font-serif">
        {RANK_LABEL(card.rank)}
        <span className="block text-[12px]">{SUIT_CHAR[card.suit]}</span>
      </span>
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="writing-vertical font-serif font-bold text-[17px] tracking-widest">{card.name}</span>
      </span>
      <span className="absolute bottom-1 right-1.5 text-[11px] opacity-70">{SUIT_CHAR[card.suit]}</span>
    </button>
  );
}

/* ---------- 勾玉体力 ---------- */

function HpGems({ hp, maxHp }: { hp: number; maxHp: number }) {
  return (
    <div className="flex gap-0.5 flex-wrap">
      {Array.from({ length: maxHp }, (_, i) => (
        <span key={i} className={`w-2.5 h-2.5 rounded-full border ${i < hp ? 'bg-amber-400 border-amber-200 shadow-[0_0_4px_rgba(251,191,36,.8)]' : 'bg-stone-700 border-stone-600'}`} />
      ))}
    </div>
  );
}

export default function Page() {
  const clientRef = useRef<NonameClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [nickname, setNickname] = useState('');
  const [roomName, setRoomName] = useState('');
  const [me, setMe] = useState<Seat | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [chat, setChat] = useState<{ from: string; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [showLogs, setShowLogs] = useState(true);
  const [selected, setSelected] = useState<{ cardId: number; targetSeat: number | null } | null>(null);
  const [respondCard, setRespondCard] = useState<number | null>(null);
  const [err, setErr] = useState('');

  const api = useCallback(async (t: string, d?: unknown) => {
    try { return await clientRef.current!.request(t, d); }
    catch (e: any) { setErr(e.message ?? String(e)); throw e; }
  }, []);

  useEffect(() => {
    if (clientRef.current) return;
    const c = new NonameClient();
    clientRef.current = c;
    c.onEvt((e: Evt) => {
      switch (e.t) {
        case 'room.list': setRooms(e.d.rooms ?? []); break;
        case 'room.state': setRoom(e.d.room); break;
        case 'room.chat': setChat(prev => [...prev.slice(-60), { from: e.d.from, text: e.d.text }]); break;
        case 'game.log': setLogs(prev => [...prev.slice(-80), e.d.text]); break;
        case 'game.start':
        case 'game.state': setGame(e.d); break;
        case 'game.state.private': setHand(e.d.hand); break;
        case 'game.over': setGame((g: any) => ({ ...g, phase: 'over', winner: e.d.winner })); break;
        case 'room.kicked': setRoom(null); setGame(null); setHand([]); break;
      }
    });
    c.connect().then(() => { setConnected(true); c.request('room.list').catch(() => {}); }).catch(() => setErr('连接失败'));
    return () => { c.close(); clientRef.current = null; };
  }, []);

  const seatByPlayerId = useCallback((id: string) =>
    game?.players.find(p => p.id === id)?.seat ?? -1, [game]);

  const mySeat = me ? seatByPlayerId(me.id) : -1;
  const mySelf = game?.players.find(p => p.seat === mySeat) ?? null;
  const opponents = useMemo(() => {
    if (!game || mySeat < 0) return [];
    // 从自己顺时针（下一家）开始排
    const ordered: PlayerBrief[] = [];
    for (let i = 1; i < game.players.length; i++) {
      const s = (mySeat + i) % game.players.length;
      const p = game.players.find(x => x.seat === s);
      if (p) ordered.push(p);
    }
    return ordered;
  }, [game, mySeat]);

  const isMyTurn = game?.phase === 'play' && game.turnSeat === mySeat && game.turnPhase === 'play' && !mySelf?.dead;
  const myPrompt = game?.prompt && game.prompt.seat === mySeat ? game.prompt : null;
  const turnPlayer = game?.players.find(p => p.seat === game.turnSeat) ?? null;

  const sendChat = async () => {
    if (!chatInput.trim()) return;
    try { await api('room.chat', { text: chatInput.trim() }); } catch {}
    setChatInput('');
  };

  const playSelected = async () => {
    if (!selected) return;
    try { await api('game.action', { type: 'play', data: { cardId: selected.cardId, targetSeat: selected.targetSeat } }); }
    catch {}
    setSelected(null);
  };

  const respond = async (cardId: number | null) => {
    try { await api('game.action', { type: 'respond', data: { cardId } }); } catch {}
    setRespondCard(null);
  };

  const endTurn = async () => { setSelected(null); try { await api('game.action', { type: 'end' }); } catch {} };

  const canPlayNow = (card: Card) => {
    if (!isMyTurn) return false;
    if (['shan'].includes(card.kind)) return false;
    if (['bagua', 'qinglong', 'fangtian', 'liannu', 'horse_plus', 'horse_minus'].includes(card.kind)) return true;
    if (card.kind === 'sha') return !!game && (!game.shaUsed || (mySelf?.equip.some(e => e.kind === 'liannu') ?? false));
    if (card.kind === 'tao') return (mySelf?.hp ?? 0) < (mySelf?.maxHp ?? 0);
    if (card.kind === 'jiu') return !!game && !game.wineUsed;
    return true;
  };

  const handleHandClick = (card: Card) => {
    if (myPrompt) {
      const ok = card.kind === myPrompt.type || (myPrompt.type === 'tao' && myPrompt.dyingSeat === mySeat && card.kind === 'jiu');
      if (ok) respond(card.id);
      return;
    }
    if (!canPlayNow(card)) return;
    if (['bagua', 'qinglong', 'fangtian', 'liannu', 'horse_plus', 'horse_minus', 'tao', 'jiu'].includes(card.kind)) {
      playDirect(card.id);
      return;
    }
    setSelected(s => (s?.cardId === card.id ? null : { cardId: card.id, targetSeat: null }));
  };

  const playDirect = async (cardId: number) => {
    try { await api('game.action', { type: 'play', data: { cardId } }); } catch {}
  };

  /* ================= 入场 ================= */
  if (!connected) {
    return (
      <main className="relative min-h-screen flex items-center justify-center bg-stone-950">
        <div className="absolute inset-0 bg-[url('/noname-assets/bg-noname.jpg')] bg-cover bg-center opacity-40" />
        <div className="relative text-center">
          <h1 className="text-4xl font-serif font-bold text-amber-500 tracking-[.3em] mb-3">无名杀</h1>
          <p className="text-stone-400 text-sm mb-8 tracking-widest">{err || '正在连接服务器…'}</p>
          {err && <Button onClick={() => location.reload()} variant="outline" className="border-amber-700 text-amber-400">重试</Button>}
        </div>
      </main>
    );
  }

  /* ================= 入座 ================= */
  if (!me) {
    return (
      <main className="relative min-h-screen flex items-center justify-center bg-stone-950">
        <div className="absolute inset-0 bg-[url('/noname-assets/bg-noname.jpg')] bg-cover bg-center opacity-40" />
        <div className="relative w-[320px]">
          <Card className="bg-stone-900/85 border-amber-900/50 backdrop-blur">
            <CardHeader><CardTitle className="text-amber-500 font-serif tracking-widest text-center text-2xl">无名杀</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Input value={nickname} maxLength={12} onChange={e => setNickname(e.target.value)} placeholder="取名（12 字内）" className="bg-stone-950 border-stone-700" />
              <Button className="w-full bg-amber-600 hover:bg-amber-500 font-bold tracking-widest" disabled={!nickname.trim()}
                onClick={async () => { try { const d = await api('hello', { name: nickname.trim() }); setMe(d); } catch {} }}>
                入 座
              </Button>
              {err && <p className="text-red-400 text-xs text-center">{err}</p>}
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  /* ================= 大厅 ================= */
  if (!room) {
    return (
      <main className="relative min-h-screen bg-stone-950">
        <div className="absolute inset-0 bg-[url('/noname-assets/bg-noname.jpg')] bg-cover bg-center opacity-20" />
        <div className="relative max-w-2xl mx-auto px-4 py-10">
          <div className="flex items-baseline justify-between mb-6">
            <h1 className="text-2xl font-serif font-bold text-amber-500 tracking-widest">无名杀 · 大厅</h1>
            <span className="text-stone-500 text-sm">{me.name}</span>
          </div>
          <div className="flex gap-2 mb-6">
            <Input value={roomName} maxLength={20} onChange={e => setRoomName(e.target.value)} placeholder="新房名" className="bg-stone-900 border-stone-700" />
            <Button className="bg-amber-600 hover:bg-amber-500 shrink-0" disabled={!roomName.trim()}
              onClick={async () => { try { const d = await api('room.create', { name: roomName.trim() }); setRoomName(''); if (d?.roomId) await api('room.join', { roomId: d.roomId }); } catch {} }}>
              建房
            </Button>
            <Button variant="outline" className="border-stone-700 shrink-0" onClick={() => api('room.list').catch(() => {})}>刷新</Button>
          </div>
          <div className="space-y-2">
            {rooms.length === 0 && <p className="text-stone-600 text-sm py-8 text-center">暂无房间，建一个吧</p>}
            {rooms.map(r => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-stone-700/80 bg-stone-900/80 px-4 py-3 backdrop-blur">
                <div>
                  <p className="text-stone-200 font-bold">{r.name}</p>
                  <p className="text-stone-500 text-xs">{r.game} · {r.players}/{r.max} 人 · {r.started ? (r.over ? '已结束' : '对局中') : '等待中'}</p>
                </div>
                <Button size="sm" variant="outline" className="border-amber-700 text-amber-400" disabled={r.started && !r.over}
                  onClick={async () => { try { await api('room.join', { roomId: r.id }); } catch {} }}>
                  {r.started && !r.over ? '观战中' : '加入'}
                </Button>
              </div>
            ))}
          </div>
          {err && <p className="text-red-400 text-xs mt-4">{err}</p>}
        </div>
      </main>
    );
  }

  /* ================= 房间（未开局） ================= */
  if (!room.started || !game) {
    return (
      <main className="relative min-h-screen bg-stone-950">
        <div className="absolute inset-0 bg-[url('/noname-assets/bg-noname.jpg')] bg-cover bg-center opacity-20" />
        <div className="relative max-w-xl mx-auto px-4 py-10">
          <h1 className="text-2xl font-serif font-bold text-amber-500 tracking-widest mb-1">{room.name}</h1>
          <p className="text-stone-500 text-sm mb-6">{room.game} · {room.members.length} 人</p>
          <div className="space-y-2 mb-6">
            {room.members.map(m => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-stone-700/80 bg-stone-900/80 px-4 py-3">
                <span className="text-stone-200">{m.name}{m.id === me.id && <span className="text-stone-500 text-xs ml-2">（你）</span>}</span>
                <span className={m.ready ? 'text-emerald-400 text-sm' : 'text-stone-500 text-sm'}>{m.ready ? '已准备' : '未准备'}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="border-stone-700" onClick={async () => { try { await api('room.leave'); setRoom(null); } catch {} }}>离开</Button>
            <Button className="bg-amber-600 hover:bg-amber-500 ml-auto"
              onClick={async () => { try { const d = await api('room.ready', { ready: !room.members.find(m => m.id === me.id)?.ready }); } catch {} }}>
              切换准备
            </Button>
          </div>
          {err && <p className="text-red-400 text-xs mt-4">{err}</p>}
        </div>
      </main>
    );
  }

  /* ================= 对局（原版布局） ================= */
  const over = game.phase === 'over';
  return (
    <main className="fixed inset-0 overflow-hidden bg-stone-950 select-none">
      {/* 背景 */}
      <div className="absolute inset-0 bg-[url('/noname-assets/bg-noname.jpg')] bg-cover bg-center" />
      <div className="absolute inset-0 bg-black/45" />

      {/* 左上：战报 */}
      <div className={`absolute top-2 left-2 z-20 w-52 md:w-64 transition-all ${showLogs ? '' : '-translate-x-[calc(100%-2.5rem)]'}`}>
        <div className="rounded-lg border border-amber-900/40 bg-black/60 backdrop-blur">
          <button className="w-full text-left px-3 py-1.5 text-xs text-amber-600 font-bold" onClick={() => setShowLogs(v => !v)}>
            ⚔ 战报 {showLogs ? '◂' : '▸'}
          </button>
          {showLogs && (
            <ScrollArea className="h-40 md:h-56 px-3 pb-2">
              <div className="text-[11px] leading-5 text-stone-300 space-y-0.5">
                {logs.slice(-40).map((l, i) => <p key={i}>{l}</p>)}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>

      {/* 右上：牌堆信息 */}
      <div className="absolute top-2 right-2 z-20 text-right text-xs text-stone-400 bg-black/50 rounded-lg px-3 py-1.5 border border-stone-700/60">
        牌堆 {game.deckCount} · 弃牌 {game.discardCount}
      </div>

      {/* 中央提示 / 响应条 */}
      {myPrompt && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 rounded-lg border border-amber-500/70 bg-black/75 backdrop-blur px-5 py-3 text-center">
          <p className="text-amber-300 font-bold text-sm mb-2">
            {myPrompt.type === 'shan' ? '请打出【闪】响应' : myPrompt.dyingSeat === mySeat ? '你濒死了！使用【桃】或【酒】自救' : `${game.players.find(p => p.seat === myPrompt.dyingSeat)?.name ?? ''} 濒死，可出【桃】相救`}
          </p>
          <Button size="sm" variant="outline" className="border-stone-600 text-stone-300" onClick={() => respond(null)}>放弃</Button>
        </div>
      )}
      {over && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70">
          <div className="text-center">
            <p className="text-3xl font-serif font-bold text-amber-400 tracking-widest mb-4">
              {game.winner ? `${game.winner} 获胜` : '对局结束'}
            </p>
            <Button className="bg-amber-600 hover:bg-amber-500" onClick={() => { setGame(null); setHand([]); setLogs([]); }}>返回房间</Button>
          </div>
        </div>
      )}

      {/* 对手环绕（右 → 上 → 左 弧形） */}
      {opponents.map((p, i) => {
        const ang = (Math.PI * (i + 1)) / (opponents.length + 1);
        const x = 50 + 43 * Math.cos(ang);
        const y = 42 - 34 * Math.sin(ang);
        const isTurn = game.turnSeat === p.seat && !over;
        const targetable = selected?.cardId != null && p.inRange && !p.dead && p.seat !== mySeat;
        return (
          <button
            key={p.id}
            disabled={!targetable}
            onClick={() => setSelected(s => (s ? { cardId: s.cardId, targetSeat: p.seat } : s))}
            style={{ left: `${x}%`, top: `${y}%` }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 z-10 flex flex-col items-center transition-all ${targetable ? 'cursor-pointer scale-105' : 'cursor-default'}`}
          >
            <div className={`w-14 h-14 md:w-16 md:h-16 rounded-full border-2 flex items-center justify-center text-xl font-serif font-bold shadow-xl ${
              p.dead ? 'border-stone-700 bg-stone-800 text-stone-600 opacity-50'
              : isTurn ? 'border-amber-400 bg-gradient-to-br from-amber-800 to-stone-800 text-amber-200 shadow-[0_0_16px_rgba(251,191,36,.5)] animate-pulse'
              : targetable ? 'border-red-400 bg-gradient-to-br from-red-950 to-stone-900 text-red-200 shadow-[0_0_12px_rgba(248,113,113,.5)]'
              : 'border-stone-500 bg-gradient-to-br from-stone-700 to-stone-900 text-stone-300'}`}>
              {p.name.slice(0, 1)}
            </div>
            <span className={`mt-1 px-1.5 rounded text-[10px] md:text-xs ${isTurn ? 'bg-amber-500 text-black font-bold' : 'bg-black/60 text-stone-300'}`}>
              {p.name}
            </span>
            <div className="mt-0.5"><HpGems hp={p.hp} maxHp={p.maxHp} /></div>
            <span className="text-[10px] text-stone-400 mt-0.5">
              手牌 {p.handCount}{!p.dead && p.seat !== mySeat ? ` · 距离${p.dist}` : ''}
            </span>
            {p.equip.length > 0 && (
              <span className="text-[10px] text-amber-600/90 mt-0.5 max-w-24 truncate">
                {p.equip.map(e => EQUIP_ICON[e.slot]).join(' ')}
              </span>
            )}
          </button>
        );
      })}

      {/* 自己：左下 */}
      {mySelf && (
        <div className="absolute left-3 bottom-32 md:left-6 md:bottom-36 z-10 flex flex-col items-center">
          <div className={`w-16 h-16 md:w-20 md:h-20 rounded-full border-2 flex items-center justify-center text-2xl font-serif font-bold shadow-xl ${
            mySelf.dead ? 'border-stone-700 bg-stone-800 text-stone-600 opacity-50'
            : isMyTurn ? 'border-amber-400 bg-gradient-to-br from-amber-800 to-stone-800 text-amber-200 shadow-[0_0_18px_rgba(251,191,36,.6)]'
            : 'border-amber-700/70 bg-gradient-to-br from-stone-700 to-stone-900 text-stone-200'}`}>
            {mySelf.name.slice(0, 1)}
          </div>
          <span className="mt-1 px-1.5 rounded text-xs bg-black/60 text-amber-300">{mySelf.name}（你）</span>
          <div className="mt-1"><HpGems hp={mySelf.hp} maxHp={mySelf.maxHp} /></div>
          <div className="mt-1 flex flex-col gap-0.5">
            {mySelf.equip.map(e => (
              <span key={e.slot} className="text-[10px] text-amber-500/90 bg-black/50 rounded px-1">
                {EQUIP_ICON[e.slot]} {e.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 当前回合阶段提示（顶部中央） */}
      {!over && turnPlayer && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 text-xs text-stone-300 bg-black/50 rounded-full px-4 py-1 border border-stone-700/60">
          {isMyTurn ? <span className="text-amber-400 font-bold">你的回合 · {PHASE_LABEL[game.turnPhase]}</span>
            : <>{turnPlayer.name} 的回合 · {PHASE_LABEL[game.turnPhase]}</>}
        </div>
      )}

      {/* 操作按钮：右下 */}
      {(isMyTurn || selected) && (
        <div className="absolute right-3 bottom-32 md:right-6 md:bottom-36 z-20 flex flex-col gap-2">
          {selected && (
            <Button className="bg-red-700 hover:bg-red-600 font-bold tracking-widest" disabled={selected.targetSeat === null} onClick={playSelected}>
              出 牌{selected.targetSeat !== null ? `→${game.players.find(p => p.seat === selected.targetSeat)?.name}` : ''}
            </Button>
          )}
          {isMyTurn && <Button variant="outline" className="border-stone-500 text-stone-200" onClick={endTurn}>结束回合</Button>}
          {selected && <Button variant="ghost" className="text-stone-400" onClick={() => setSelected(null)}>取消</Button>}
        </div>
      )}

      {/* 手牌：底部重叠横排 */}
      <div className="absolute bottom-0 inset-x-0 z-30">
        <div className="flex justify-center items-end px-2 pb-1 overflow-x-auto pt-6">
          {hand.map((c, i) => {
            const selectable = isMyTurn ? canPlayNow(c) : !!(myPrompt && (c.kind === myPrompt.type || (myPrompt.type === 'tao' && myPrompt.dyingSeat === mySeat && c.kind === 'jiu')));
            const isSelected = selected?.cardId === c.id;
            return (
              <div key={c.id} className={i === 0 ? '' : '-ml-8'} style={{ zIndex: isSelected ? 50 : i }}>
                <CardFace card={c} selected={isSelected || respondCard === c.id} onClick={() => handleHandClick(c)} />
                {!selectable && !myPrompt && isMyTurn && <span />}
              </div>
            );
          })}
          {hand.length === 0 && <p className="text-stone-600 text-xs pb-4">（无手牌）</p>}
        </div>
        {!isMyTurn && !myPrompt && !over && (
          <p className="text-center text-[11px] text-stone-500 pb-1 -mt-5">等待 {turnPlayer?.name ?? ''} 行动…</p>
        )}
      </div>

      {/* 聊天：右下浮层 */}
      <details className="absolute bottom-1 right-2 z-40 md:bottom-2">
        <summary className="list-none cursor-pointer rounded-full bg-black/70 border border-stone-600 px-3 py-1 text-xs text-stone-300">💬 聊天</summary>
        <div className="absolute bottom-10 right-0 w-60 rounded-lg border border-stone-700 bg-black/80 backdrop-blur p-2">
          <ScrollArea className="h-36">
            <div className="text-xs space-y-1 text-stone-300 px-1">
              {chat.length === 0 && <p className="text-stone-600">（暂无发言）</p>}
              {chat.map((m, i) => <p key={i}><span className="text-amber-500">{m.from}：</span>{m.text}</p>)}
            </div>
          </ScrollArea>
          <div className="flex gap-1 mt-1">
            <Input value={chatInput} maxLength={120} onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendChat()} placeholder="发言…" className="h-7 text-xs bg-stone-950 border-stone-700" />
          </div>
        </div>
      </details>

      {err && <p className="absolute bottom-24 left-1/2 -translate-x-1/2 text-red-400 text-xs bg-black/70 px-3 py-1 rounded z-40">{err}</p>}
    </main>
  );
}
