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
type TurnPhase = 'prepare' | 'judgment' | 'draw' | 'play' | 'discard' | 'finish';
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
type RoomState = { id: string; name: string; game: string; members: { id: string; name: string; ready: boolean }[]; started: boolean; over: boolean };
type RoomSummary = { id: string; name: string; players: number; max: number; started: boolean; over: boolean };

/* ---------- 牌面视觉 ---------- */

const SUIT_SYM: Record<Suit, string> = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
const SUIT_IS_RED: Record<Suit, boolean> = { spade: false, heart: true, club: false, diamond: true };
const RANK_LABEL = (r: number) => (r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r));

/** 牌面底色：按花色红黑分，装备金边 */
function cardFaceClass(c: { kind: CardKind; suit: Suit }) {
  const isEquip = ['bagua', 'qinglong', 'fangtian', 'liannu', 'horse_plus', 'horse_minus'].includes(c.kind);
  if (isEquip) return 'bg-gradient-to-b from-yellow-900/90 to-yellow-950 border-yellow-600/80 text-yellow-50';
  if (c.kind === 'sha') return SUIT_IS_RED[c.suit]
    ? 'bg-gradient-to-b from-red-800/90 to-red-950 border-red-600 text-red-50'
    : 'bg-gradient-to-b from-zinc-700/90 to-zinc-900 border-zinc-500 text-zinc-50';
  if (c.kind === 'shan') return 'bg-gradient-to-b from-slate-600/80 to-slate-900 border-slate-400 text-slate-50';
  if (c.kind === 'tao') return 'bg-gradient-to-b from-pink-800/90 to-pink-950 border-pink-600 text-pink-50';
  return 'bg-gradient-to-b from-amber-800/90 to-amber-950 border-amber-600 text-amber-50'; // 酒
}

const EQUIP_ICON: Record<EquipSlot, string> = { weapon: '⚔', armor: '🛡', 'horse+': '🛡＋马', 'horse-': '⚔－马' };
const EQUIP_BADGE: Record<EquipSlot, string> = { weapon: '⚔', armor: '🛡', 'horse+': '＋', 'horse-': '－' };

const PHASES: { key: TurnPhase; label: string }[] = [
  { key: 'prepare', label: '准备' },
  { key: 'judgment', label: '判定' },
  { key: 'draw', label: '摸牌' },
  { key: 'play', label: '出牌' },
  { key: 'discard', label: '弃牌' },
  { key: 'finish', label: '结束' },
];

/* ---------- 页面 ---------- */

export default function Page() {
  const [phase, setPhase] = useState<'gate' | 'lobby' | 'room'>('gate');
  const [nameInput, setNameInput] = useState('');
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [online, setOnline] = useState(0);
  const [roomName, setRoomName] = useState('');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [logs, setLogs] = useState<{ text: string; ts: number }[]>([]);
  const [chat, setChat] = useState<{ from: string; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [selected, setSelected] = useState<{ cardId: number; targetSeat: number | null } | null>(null);
  const [now, setNow] = useState(Date.now());
  const clientRef = useRef<NonameClient | null>(null);
  const nameRef = useRef('无名玩家');
  const myId = me?.id ?? '';

  /* ---------- 连接与事件分发 ---------- */
  useEffect(() => {
    if (phase === 'gate') return;
    const c = new NonameClient();
    clientRef.current = c;
    let alive = true;

    c.connect()
      .then(async () => {
        if (!alive) return;
        try {
          const d = await c.request('hello', { name: nameRef.current });
          setMe(d);
        } catch (e: any) {
          setErr(e.message ?? '连接失败');
          setPhase('gate');
        }
      })
      .catch(() => {
        setErr('联机服务不可达');
        setPhase('gate');
      });

    const off = c.onEvt((e: Evt) => {
      switch (e.t) {
        case 'lobby.state': setRooms(e.d.rooms); setOnline(e.d.online); break;
        case 'room.joined': setRoom(e.d); setPhase('room'); setLogs([]); setChat([]); setGame(null); setHand([]); break;
        case 'room.state': setRoom(e.d); break;
        case 'room.chat': setChat(prev => [...prev.slice(-80), e.d]); break;
        case 'game.start': setLogs([]); setSelected(null); break;
        case 'game.log': setLogs(prev => [...prev.slice(-200), e.d]); break;
        case 'game.state': setGame(e.d); break;
        case 'game.state.private': setHand(e.d.hand); break;
        case 'game.over': setGame(e.d.state ?? null); break;
      }
    });

    return () => { alive = false; off(); c.close(); clientRef.current = null; };
  }, [phase === 'gate']);

  /* 大厅轮询刷新 */
  useEffect(() => {
    if (phase !== 'lobby' || !clientRef.current?.connected) return;
    const tick = () => clientRef.current?.request('lobby.refresh').then(d => {
      setRooms(d.rooms); setOnline(d.online);
    }).catch(() => {});
    tick();
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [phase, me]);

  /* 计时器（响应倒计时） */
  useEffect(() => {
    if (!game?.prompt) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [game?.prompt?.until]);

  /* ---------- 操作 ---------- */
  const api = useCallback((t: string, d?: unknown) => clientRef.current?.request(t, d), []);

  const enterLobby = async () => {
    setErr('');
    nameRef.current = nameInput.trim() || '无名玩家';
    setPhase('lobby');
  };

  const createRoom = async () => {
    try {
      await api('room.create', { name: roomName.trim() || `${me?.name}的房间` });
      setRoomName('');
    } catch (e: any) { setErr(e.message); }
  };

  const joinRoom = async (roomId: string) => {
    try { await api('room.join', { roomId }); } catch (e: any) { setErr(e.message); }
  };

  const leaveRoom = async () => {
    await api('room.leave');
    setRoom(null); setGame(null); setHand([]); setPhase('lobby');
  };

  const toggleReady = () => {
    const m = room?.members.find(x => x.id === myId);
    api('room.ready', { ready: !(m?.ready ?? false) });
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    api('room.chat', { text });
    setChatInput('');
  };

  const me_ = game?.players.find(p => p.id === myId);
  const mySeat = me_?.seat ?? -1;
  const isMyTurn = game?.phase === 'play' && game.turnPhase === 'play' && game.turnSeat === mySeat && !me_?.dead;
  const myPrompt = game?.prompt && game.prompt.seat === mySeat ? game.prompt : null;
  const promptLeft = myPrompt ? Math.max(0, Math.ceil((myPrompt.until - now) / 1000)) : 0;

  const playCard = async () => {
    if (!selected) return;
    try {
      await api('game.action', { type: 'play', data: { cardId: selected.cardId, targetSeat: selected.targetSeat } });
      setSelected(null);
    } catch {}
  };

  const respond = async (cardId: number | null) => {
    try { await api('game.action', { type: 'respond', data: { cardId } }); } catch {}
  };

  const selectedCard = selected ? hand.find(c => c.id === selected.cardId) : undefined;
  const isSha = selectedCard?.kind === 'sha';

  const canPlaySelected = useMemo(() => {
    if (!selectedCard || !game || !isMyTurn) return false;
    if (isSha) return (!game.shaUsed || me_?.equip.some(e => e.kind === 'liannu')) && selected?.targetSeat !== null;
    if (selectedCard.kind === 'tao') return (me_?.hp ?? 0) < (me_?.maxHp ?? 0);
    if (selectedCard.kind === 'shan') return false;
    return true; // 酒 / 装备
  }, [selectedCard, game, isMyTurn, isSha, selected, me_]);

  /* ---------- 视图 ---------- */

  if (phase === 'gate') {
    return (
      <main className="min-h-screen bg-stone-950 text-stone-100 flex items-center justify-center p-4 bg-[radial-gradient(ellipse_at_top,rgba(180,120,40,0.14),transparent_60%)]">
        <Card className="w-full max-w-sm bg-stone-900/90 border-stone-800 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-amber-400 text-xl tracking-wide">无名杀 · 联机</CardTitle>
            <p className="text-sm text-stone-400">服务端权威 · 协议 v1.1</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="昵称（最多 12 字）" maxLength={12} value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && nameInput.trim() && enterLobby()}
              className="bg-stone-950 border-stone-700"
            />
            {err && <p className="text-sm text-red-400">{err}</p>}
            <Button
              className="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
              disabled={!nameInput.trim()} onClick={enterLobby}
            >
              进入大厅
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (phase === 'lobby') {
    return (
      <main className="min-h-screen bg-stone-950 text-stone-100 bg-[radial-gradient(ellipse_at_top,rgba(180,120,40,0.10),transparent_55%)]">
        <div className="mx-auto max-w-2xl p-4 space-y-4">
          <header className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="text-xl font-semibold text-amber-400">房间列表</h1>
            <div className="flex items-center gap-2 text-sm text-stone-400">
              <span>{me?.name ?? nameRef.current}</span><span>·</span><span>在线 {online}</span>
            </div>
          </header>

          <div className="flex gap-2">
            <Input
              placeholder="新房间名" maxLength={20} value={roomName}
              onChange={e => setRoomName(e.target.value)}
              className="bg-stone-900 border-stone-700"
            />
            <Button className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold shrink-0" onClick={createRoom}>
              创建房间
            </Button>
          </div>
          {err && <p className="text-sm text-red-400">{err}</p>}

          <ScrollArea className="h-[60vh]">
            <div className="space-y-2 pr-2">
              {rooms.length === 0 && (
                <p className="text-stone-500 text-sm py-8 text-center">还没有房间，创建一个吧</p>
              )}
              {rooms.map(r => (
                <div key={r.id} className="flex items-center justify-between bg-stone-900/90 border border-stone-800 rounded-lg px-4 py-3">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-stone-400">{r.players}/{r.max} 人 · {r.started ? '对局中' : '等待中'}</p>
                  </div>
                  <Button variant="outline" className="border-stone-700 hover:bg-stone-800" onClick={() => joinRoom(r.id)}>
                    进入
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </main>
    );
  }

  /* ---------- 房间 ---------- */
  const members = room?.members ?? [];
  const allReady = members.length >= 2 && members.every(m => m.ready);
  const showTable = game && game.players.length >= 2;

  /* 对手按座位顺时针排列（从我的下家开始），视觉成环 */
  const others = useMemo(() => {
    if (!game) return [];
    const list = game.players.filter(p => p.seat !== mySeat && p.seat >= 0);
    const sorted = [...list].sort((a, b) => a.seat - b.seat);
    const idx = sorted.findIndex(p => p.seat > mySeat);
    const rotated = idx >= 0 ? [...sorted.slice(idx), ...sorted.slice(0, idx)] : sorted;
    return rotated.filter(p => p.seat >= 0);
  }, [game, mySeat]);

  return (
    <main className="min-h-screen text-stone-100 bg-stone-950 bg-[radial-gradient(ellipse_at_center,rgba(120,80,30,0.16),transparent_65%)]">
      <div className="mx-auto max-w-5xl p-3 sm:p-4 space-y-3">
        <header className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-lg font-semibold text-amber-400">{room?.name}</h1>
          <div className="flex items-center gap-3">
            {showTable && (
              <span className="text-xs text-stone-400">
                牌堆 <b className="text-stone-200">{game!.deckCount}</b> · 弃牌 {game!.discardCount}
              </span>
            )}
            <Button variant="outline" className="border-stone-700 hover:bg-stone-800" onClick={leaveRoom}>
              离开房间
            </Button>
          </div>
        </header>

        {/* 成员 / 准备区 */}
        {!showTable && (
          <Card className="bg-stone-900/90 border-stone-800">
            <CardContent className="p-4 space-y-3">
              <div className="space-y-2">
                {members.map(m => (
                  <div key={m.id} className="flex items-center justify-between text-sm">
                    <span>{m.name}{m.id === myId && <span className="text-stone-500">（你）</span>}</span>
                    <span className={m.ready ? 'text-emerald-400' : 'text-stone-500'}>{m.ready ? '已准备' : '未准备'}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-stone-500">
                {members.length < 2 ? '至少 2 人才能开局，把链接发给朋友吧' : allReady ? '即将开局…' : '全员准备后自动开局'}
              </p>
              <Button className="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold" onClick={toggleReady}>
                {members.find(m => m.id === myId)?.ready ? '取消准备' : '准备'}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* 牌桌 */}
        {showTable && (
          <div className="space-y-3">
            {/* 阶段指示条 */}
            <div className="flex items-center justify-center gap-1 sm:gap-2 flex-wrap text-[11px] sm:text-xs">
              {PHASES.map((ph, i) => {
                const active = game!.phase === 'play' && game!.turnPhase === ph.key;
                return (
                  <span key={ph.key} className="flex items-center gap-1 sm:gap-2">
                    {i > 0 && <span className="text-stone-700">→</span>}
                    <span className={`px-2 py-0.5 rounded-full border ${active ? 'border-amber-500 bg-amber-950/50 text-amber-300 font-semibold' : 'border-stone-800 text-stone-600'}`}>
                      {ph.label}
                    </span>
                  </span>
                );
              })}
            </div>

            {/* 对手席位 */}
            <div className="flex flex-wrap justify-center gap-2">
              {others.map(p => {
                const isTarget = selected?.targetSeat === p.seat;
                const selectable = isMyTurn && isSha && !p.dead && p.inRange && (!game!.shaUsed || !!me_?.equip.some(e => e.kind === 'liannu'));
                return (
                  <button
                    key={p.id}
                    disabled={!selectable}
                    onClick={() => setSelected(s => (s && s.targetSeat === p.seat) ? { cardId: s.cardId, targetSeat: null } : (s ? { cardId: s.cardId, targetSeat: p.seat } : s))}
                    className={`text-left rounded-lg border px-3 py-2 min-w-[140px] transition-all ${
                      p.dead ? 'opacity-35 border-stone-800 bg-stone-950'
                      : isTarget ? 'border-amber-400 bg-amber-950/50 ring-2 ring-amber-500/60 scale-[1.02]'
                      : selectable ? 'border-stone-600 bg-stone-900 cursor-pointer hover:border-amber-700/60'
                      : game!.turnSeat === p.seat && game!.phase === 'play' ? 'border-amber-700/60 bg-stone-900' : 'border-stone-800 bg-stone-900'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate max-w-[120px]">{p.name}{p.dead && <span className="text-xs text-stone-500"> 阵亡</span>}</span>
                      <span className="text-[10px] text-stone-500 shrink-0">手牌 {p.handCount}</span>
                    </div>
                    {/* 体力勾玉 */}
                    <div className="mt-1.5 flex gap-1 flex-wrap">
                      {Array.from({ length: p.maxHp }).map((_, i) => (
                        <span key={i} className={`inline-block w-2.5 h-2.5 rounded-full border ${i < p.hp ? 'bg-red-500 border-red-300/70 shadow-[0_0_4px_rgba(239,68,68,0.7)]' : 'bg-stone-800 border-stone-700'}`} />
                      ))}
                    </div>
                    {/* 装备徽章 */}
                    {p.equip.length > 0 && (
                      <div className="mt-1.5 flex gap-1 flex-wrap">
                        {p.equip.map(e => (
                          <span key={e.slot} className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-950/70 border border-yellow-800/60 text-yellow-200/90">
                            {EQUIP_BADGE[e.slot]} {e.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-[10px] text-stone-500">
                        {game!.turnSeat === p.seat && !p.dead && game!.phase === 'play' ? '行动中…' : `距离 ${p.dist}`}
                      </span>
                      {selectable && <span className="text-[10px] text-amber-400">可攻击</span>}
                      {!selectable && isMyTurn && isSha && !p.dead && !p.inRange && (
                        <span className="text-[10px] text-stone-600">距离不足</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 中央提示 */}
            {myPrompt ? (
              <div className="rounded-lg border border-amber-500 bg-amber-950/40 px-4 py-3 backdrop-blur">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-sm text-amber-300">
                    {myPrompt.type === 'shan' ? '是否打出【闪】抵消【杀】？' : `濒死！是否打出【${myPrompt.dyingSeat === mySeat ? '桃／酒自救' : '桃'}】？`}
                    <span className="text-stone-400">（{promptLeft}s）</span>
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                      onClick={() => {
                        const dyingSelf = myPrompt!.dyingSeat === mySeat;
                        const card = hand.find(c => c.kind === myPrompt!.type || (myPrompt!.type === 'tao' && dyingSelf && c.kind === 'jiu'));
                        if (card) respond(card.id);
                      }}>
                      出牌响应
                    </Button>
                    <Button size="sm" variant="outline" className="border-stone-600 hover:bg-stone-800" onClick={() => respond(null)}>
                      放弃
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-center text-sm text-stone-400">
                {game!.phase === 'over'
                  ? `对局结束：${game!.winner ?? '平局'} 获胜`
                  : game!.phase === 'play'
                    ? game!.turnSeat === mySeat
                      ? game!.turnPhase === 'play' ? '轮到你出牌' : `你的回合 · ${PHASES.find(x => x.key === game!.turnPhase)?.label ?? ''}阶段`
                      : `等待 ${game!.players.find(p => p.seat === game!.turnSeat)?.name ?? ''}（${PHASES.find(x => x.key === game!.turnPhase)?.label ?? ''}）…`
                    : ''}
              </p>
            )}

            {/* 对局结束返回准备区 */}
            {game!.phase === 'over' && (
              <div className="flex justify-center gap-2">
                <Button className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                  onClick={() => { setGame(null); setHand([]); }}>
                  返回准备区
                </Button>
              </div>
            )}

            {/* 自己面板 */}
            <div className="rounded-lg border border-stone-800 bg-stone-900/80 backdrop-blur p-3 space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{me_?.name ?? '你'}</span>
                  <span className="flex gap-1">
                    {Array.from({ length: me_?.maxHp ?? 0 }).map((_, i) => (
                      <span key={i} className={`inline-block w-3 h-3 rounded-full border ${i < (me_?.hp ?? 0) ? 'bg-red-500 border-red-300/70 shadow-[0_0_5px_rgba(239,68,68,0.7)]' : 'bg-stone-800 border-stone-700'}`} />
                    ))}
                  </span>
                  <span className="text-xs text-stone-500">{me_?.hp ?? 0}/{me_?.maxHp ?? 0}</span>
                  {isMyTurn && game!.shaUsed && !me_?.equip.some(e => e.kind === 'liannu') && (
                    <span className="text-xs text-stone-500">· 本回合【杀】已用</span>
                  )}
                  {isMyTurn && game!.wineUsed && <span className="text-xs text-amber-500/80">· 酒已用</span>}
                </div>
                {/* 装备区 */}
                <div className="flex gap-1 flex-wrap">
                  {(['weapon', 'armor', 'horse+', 'horse-'] as EquipSlot[]).map(slot => {
                    const e = me_?.equip.find(x => x.slot === slot);
                    return (
                      <span key={slot} className={`text-[10px] px-2 py-0.5 rounded border ${e ? 'bg-yellow-950/70 border-yellow-700/60 text-yellow-200' : 'bg-stone-950 border-stone-800 text-stone-700'}`}>
                        {e ? `${EQUIP_ICON[slot]} ${e.name}` : EQUIP_ICON[slot] + ' 空'}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* 手牌 */}
              <div className="flex gap-2 overflow-x-auto pb-1 min-h-[96px] items-end">
                {hand.length === 0 && <p className="text-stone-600 text-sm py-4">（空）</p>}
                {hand.map(c => {
                  const isSel = selected?.cardId === c.id;
                  const responseMatch = myPrompt && (c.kind === myPrompt.type || (myPrompt.type === 'tao' && myPrompt.dyingSeat === mySeat && c.kind === 'jiu'));
                  const dim = !!myPrompt && !responseMatch;
                  return (
                    <button
                      key={c.id}
                      onClick={() => { if (myPrompt) return; setSelected(s => (s?.cardId === c.id ? null : { cardId: c.id, targetSeat: null })); }}
                      className={`relative w-[62px] h-[88px] shrink-0 rounded-lg border flex flex-col items-center justify-center transition-all ${cardFaceClass(c)} ${
                        isSel ? 'ring-2 ring-amber-400 -translate-y-2 shadow-lg shadow-amber-900/40' : ''
                      } ${responseMatch ? 'ring-2 ring-emerald-400 -translate-y-1' : ''} ${dim ? 'opacity-40' : 'hover:-translate-y-1'}`}
                    >
                      <span className="absolute top-1 left-1.5 text-[10px] leading-none font-mono">
                        {RANK_LABEL(c.rank)}<span className={SUIT_IS_RED[c.suit] ? 'text-red-400' : 'text-stone-300'}>{SUIT_SYM[c.suit]}</span>
                      </span>
                      <span className="font-semibold text-sm px-1 text-center leading-tight">{c.name}</span>
                      <span className={`absolute bottom-1 right-1.5 text-[10px] leading-none rotate-180 font-mono ${SUIT_IS_RED[c.suit] ? 'text-red-400' : 'text-stone-300'}`}>
                        {RANK_LABEL(c.rank)}{SUIT_SYM[c.suit]}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 操作按钮 */}
              {isMyTurn && !myPrompt && (
                <div className="flex gap-2 justify-center flex-wrap">
                  <Button
                    className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                    disabled={!canPlaySelected}
                    onClick={playCard}
                  >
                    出牌{selectedCard ? (
                      isSha ? (selected?.targetSeat !== null ? ` → ${game!.players.find(p => p.seat === selected?.targetSeat)?.name}` : '（先选目标）')
                      : `：【${selectedCard.name}】`
                    ) : ''}
                  </Button>
                  <Button variant="outline" className="border-stone-600 hover:bg-stone-800" onClick={() => api('game.action', { type: 'end' })}>
                    结束回合
                  </Button>
                  {selected && (
                    <Button variant="ghost" className="text-stone-400" onClick={() => setSelected(null)}>
                      取消选择
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 记录 + 聊天 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card className="bg-stone-900/90 border-stone-800">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-stone-300">对局记录</CardTitle></CardHeader>
            <CardContent className="p-0 pb-3">
              <ScrollArea className="h-40">
                <div className="px-4 text-xs space-y-1 text-stone-400">
                  {logs.length === 0 && <p className="text-stone-600 py-4">（暂无）</p>}
                  {logs.map((l, i) => <p key={i}>{l.text}</p>)}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
          <Card className="bg-stone-900/90 border-stone-800">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-stone-300">聊天</CardTitle></CardHeader>
            <CardContent className="p-0 pb-3">
              <ScrollArea className="h-32">
                <div className="px-4 text-xs space-y-1 text-stone-400">
                  {chat.length === 0 && <p className="text-stone-600 py-4">（暂无发言）</p>}
                  {chat.map((m, i) => <p key={i}><span className="text-amber-500">{m.from}：</span>{m.text}</p>)}
                </div>
              </ScrollArea>
              <div className="px-4 pt-2 flex gap-2">
                <Input
                  value={chatInput} maxLength={120}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendChat()}
                  placeholder="发言…"
                  className="h-8 text-xs bg-stone-950 border-stone-700"
                />
                <Button size="sm" variant="outline" className="border-stone-700 hover:bg-stone-800 shrink-0" onClick={sendChat}>
                  发送
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
