'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { NonameClient, type Evt } from '@/lib/noname-client';

/* ---------- 类型（与服务端协议 v1 对应） ---------- */

type Card = { id: number; kind: 'sha' | 'shan' | 'tao' | 'wuzhong'; name: string };
type PlayerBrief = { seat: number; id: string; name: string; hp: number; maxHp: number; handCount: number; dead: boolean };
type GameState = {
  players: PlayerBrief[];
  turnSeat: number;
  phase: 'play' | 'over';
  prompt: { type: 'shan' | 'tao'; seat: number; fromSeat: number | null; until: number } | null;
  shaUsed: boolean;
  discardCount: number;
  winner: string | null;
};
type RoomState = { id: string; name: string; game: string; members: { id: string; name: string; ready: boolean }[]; started: boolean; over: boolean };
type RoomSummary = { id: string; name: string; players: number; max: number; started: boolean; over: boolean };

const CARD_COLOR: Record<string, string> = {
  sha: 'bg-red-900/80 border-red-700 text-red-50',
  shan: 'bg-stone-700/80 border-stone-500 text-stone-100',
  tao: 'bg-emerald-900/80 border-emerald-700 text-emerald-50',
  wuzhong: 'bg-amber-900/80 border-amber-600 text-amber-50',
};

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
        case 'lobby.state':
          setRooms(e.d.rooms);
          setOnline(e.d.online);
          break;
        case 'room.joined':
          setRoom(e.d);
          setPhase('room');
          setLogs([]);
          setChat([]);
          setGame(null);
          setHand([]);
          break;
        case 'room.state':
          setRoom(e.d);
          break;
        case 'room.chat':
          setChat(prev => [...prev.slice(-80), e.d]);
          break;
        case 'game.start':
          setLogs([]);
          setSelected(null);
          break;
        case 'game.log':
          setLogs(prev => [...prev.slice(-200), e.d]);
          break;
        case 'game.state':
          setGame(e.d);
          break;
        case 'game.state.private':
          setHand(e.d.hand);
          break;
        case 'game.over':
          setGame(e.d.state ?? null);
          break;
      }
    });

    return () => {
      alive = false;
      off();
      c.close();
      clientRef.current = null;
    };
  }, [phase === 'gate']);

  /* 大厅轮询刷新 */
  useEffect(() => {
    if (phase !== 'lobby' || !clientRef.current?.connected) return;
    const tick = () => clientRef.current?.request('lobby.refresh').then(d => {
      setRooms(d.rooms);
      setOnline(d.online);
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
    setRoom(null);
    setGame(null);
    setHand([]);
    setPhase('lobby');
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

  const mySeat = game?.players.find(p => p.id === myId)?.seat ?? -1;
  const isMyTurn = game?.phase === 'play' && game.turnSeat === mySeat && !game.players.find(p => p.seat === mySeat)?.dead;
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

  const canPlaySelected = useMemo(() => {
    if (!selected || !game) return false;
    const card = hand.find(c => c.id === selected.cardId);
    if (!card) return false;
    if (card.kind === 'sha') return !game.shaUsed && selected.targetSeat !== null;
    return true;
  }, [selected, hand, game]);

  /* ---------- 视图 ---------- */

  if (phase === 'gate') {
    return (
      <main className="min-h-screen bg-stone-950 text-stone-100 flex items-center justify-center p-4">
        <Card className="w-full max-w-sm bg-stone-900 border-stone-800">
          <CardHeader>
            <CardTitle className="text-amber-400 text-xl">无名杀 · 联机大厅</CardTitle>
            <p className="text-sm text-stone-400">新协议 v1 · 服务端权威托管</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="昵称（最多 12 字）"
              maxLength={12}
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && nameInput.trim() && enterLobby()}
              className="bg-stone-950 border-stone-700"
            />
            {err && <p className="text-sm text-red-400">{err}</p>}
            <Button
              className="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
              disabled={!nameInput.trim()}
              onClick={enterLobby}
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
      <main className="min-h-screen bg-stone-950 text-stone-100">
        <div className="mx-auto max-w-2xl p-4 space-y-4">
          <header className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="text-xl font-semibold text-amber-400">房间列表</h1>
            <div className="flex items-center gap-2 text-sm text-stone-400">
              <span>{me?.name ?? nameRef.current}</span><span>·</span><span>在线 {online}</span>
            </div>
          </header>

          <div className="flex gap-2">
            <Input
              placeholder="新房间名"
              maxLength={20}
              value={roomName}
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
                <div key={r.id} className="flex items-center justify-between bg-stone-900 border border-stone-800 rounded-lg px-4 py-3">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-stone-400">{r.players}/{r.max} 人 · {r.started ? '对局中' : '等待中'}</p>
                  </div>
                  <Button
                    variant="outline"
                    className="border-stone-700 hover:bg-stone-800"
                    onClick={() => joinRoom(r.id)}
                  >
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

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100">
      <div className="mx-auto max-w-3xl p-4 space-y-4">
        <header className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-lg font-semibold text-amber-400">{room?.name}</h1>
          <Button variant="outline" className="border-stone-700 hover:bg-stone-800" onClick={leaveRoom}>
            离开房间
          </Button>
        </header>

        {/* 成员 / 准备区（未开局时显示） */}
        {!showTable && (
          <Card className="bg-stone-900 border-stone-800">
            <CardContent className="p-4 space-y-3">
              <div className="space-y-2">
                {members.map(m => (
                  <div key={m.id} className="flex items-center justify-between text-sm">
                    <span>{m.name}{m.id === myId && <span className="text-stone-500">（你）</span>}</span>
                    <span className={m.ready ? 'text-emerald-400' : 'text-stone-500'}>
                      {m.ready ? '已准备' : '未准备'}
                    </span>
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
          <Card className="bg-stone-900 border-stone-800">
            <CardContent className="p-4 space-y-4">
              {/* 其他玩家 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {game!.players.filter(p => p.seat !== mySeat).map(p => {
                  const isTarget = selected?.targetSeat === p.seat;
                  return (
                    <button
                      key={p.id}
                      disabled={!isMyTurn || p.dead || selected?.cardId === undefined || hand.find(c => c.id === selected?.cardId)?.kind !== 'sha'}
                      onClick={() => setSelected(s => (s && s.targetSeat === p.seat) ? { ...s, targetSeat: null } : { ...s, targetSeat: p.seat })}
                      className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                        p.dead ? 'opacity-40 border-stone-800 bg-stone-950'
                        : isTarget ? 'border-amber-500 bg-amber-950/40'
                        : game!.turnSeat === p.seat ? 'border-amber-700/60 bg-stone-950' : 'border-stone-800 bg-stone-950'
                      } ${(!isMyTurn || p.dead) ? 'cursor-default' : 'cursor-pointer'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{p.name}{p.dead && <span className="text-xs text-stone-500"> 阵亡</span>}</span>
                        <span className="text-xs text-stone-400">手牌 {p.handCount}</span>
                      </div>
                      <div className="mt-1 flex gap-0.5">
                        {Array.from({ length: p.maxHp }).map((_, i) => (
                          <span key={i} className={`w-2.5 h-2.5 rounded-full ${i < p.hp ? 'bg-red-600' : 'bg-stone-800'}`} />
                        ))}
                      </div>
                      {game!.turnSeat === p.seat && !p.dead && game!.phase === 'play' && (
                        <p className="text-xs text-amber-500 mt-1">出牌中…</p>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 提示条 */}
              {myPrompt ? (
                <div className="rounded-lg border border-amber-600 bg-amber-950/30 px-4 py-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-sm text-amber-300">
                      {myPrompt.type === 'shan' ? '是否打出【闪】抵消【杀】？' : '濒死！是否打出【桃】自救？'}
                      <span className="text-stone-400">（{promptLeft}s）</span>
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                        onClick={() => {
                          const card = hand.find(c => c.kind === myPrompt!.type);
                          if (card) respond(card.id);
                        }}>
                        出{myPrompt.type === 'shan' ? '闪' : '桃'}
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
                    : isMyTurn ? '轮到你出牌' : '等待对方出牌…'}
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

              {/* 自己的手牌 */}
              <div>
                <p className="text-xs text-stone-500 mb-1">
                  你的手牌（体力 {game!.players.find(p => p.seat === mySeat)?.hp ?? 0}/
                  {game!.players.find(p => p.seat === mySeat)?.maxHp ?? 0}
                  {isMyTurn && game!.shaUsed ? ' · 本回合【杀】已用' : ''}）
                </p>
                <div className="flex gap-2 flex-wrap min-h-[72px]">
                  {hand.length === 0 && <p className="text-stone-600 text-sm py-4">（空）</p>}
                  {hand.map(c => {
                    const isSel = selected?.cardId === c.id;
                    const isResponseCard = myPrompt && c.kind === myPrompt.type;
                    return (
                      <button
                        key={c.id}
                        onClick={() => {
                          if (myPrompt) return;
                          setSelected(s => (s?.cardId === c.id ? null : { cardId: c.id, targetSeat: null }));
                        }}
                        className={`w-16 h-24 rounded-lg border flex flex-col items-center justify-center text-sm transition-transform ${
                          CARD_COLOR[c.kind]
                        } ${isSel ? 'ring-2 ring-amber-400 -translate-y-2' : ''} ${isResponseCard ? 'ring-2 ring-emerald-400' : ''}`}
                      >
                        <span className="font-semibold">{c.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 操作按钮 */}
              {isMyTurn && !myPrompt && game!.phase === 'play' && (
                <div className="flex gap-2 justify-center">
                  <Button
                    className="bg-amber-600 hover:bg-amber-500 text-stone-950 font-semibold"
                    disabled={!canPlaySelected}
                    onClick={playCard}
                  >
                    出牌{selected && hand.find(c => c.id === selected.cardId)?.kind === 'sha' ? (selected.targetSeat !== null ? ` → ${game!.players.find(p => p.seat === selected.targetSeat)?.name}` : '（先点目标）') : ''}
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
            </CardContent>
          </Card>
        )}

        {/* 记录 + 聊天 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="bg-stone-900 border-stone-800">
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
          <Card className="bg-stone-900 border-stone-800">
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
                  value={chatInput}
                  maxLength={120}
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
