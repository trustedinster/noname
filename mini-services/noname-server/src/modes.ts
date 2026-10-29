/**
 * 模式定义 —— 按人数决定模式，按模式配置规则。
 *
 * 人数 → 模式：
 *   2 → 1v1 · 3 → 斗地主 · 4 → 2v2 · 8 → 军争八人身份场 · 5/6/7 → 暂无
 *
 * 胜利判定统一收口在 winnerCheck：传入存活者的角色，返回获胜阵营名或 null（继续打）。
 */

export type RoleId = "zhu" | "zhong" | "fan" | "nei" | "lord" | "farmer" | "team_a" | "team_b";

export interface RoleDef {
  id: RoleId;
  name: string;
  camp: string;
}

export interface ModeConfig {
  id: string;
  name: string;
  players: number;
  /** 座位角色表（开局时打乱分配，顺序无关） */
  roles: RoleDef[];
  /** 体力覆盖（未指定的角色默认 4） */
  hp?: Partial<Record<RoleId, number>>;
  /** 开局即公开身份的角色（主公/地主） */
  revealed: RoleId[];
  /** 同阵营互见身份（队友） */
  teammateVisible: boolean;
  /** 存活者 → 获胜阵营名 | null（继续） */
  winnerCheck: (alive: { role: RoleId; camp: string }[]) => string | null;
}

export const ROLE: Record<RoleId, RoleDef> = {
  zhu: { id: "zhu", name: "主公", camp: "lord_side" },
  zhong: { id: "zhong", name: "忠臣", camp: "lord_side" },
  fan: { id: "fan", name: "反贼", camp: "rebel" },
  nei: { id: "nei", name: "内奸", camp: "traitor" },
  lord: { id: "lord", name: "地主", camp: "lord_p" },
  farmer: { id: "farmer", name: "农民", camp: "farmer_p" },
  team_a: { id: "team_a", name: "红队", camp: "team_a" },
  team_b: { id: "team_b", name: "蓝队", camp: "team_b" },
};

/** 通用阵营判定：只剩一个阵营存活即胜（1v1 / 斗地主 / 2v2） */
function campWinner(alive: { role: RoleId; camp: string }[]): string | null {
  const camps = [...new Set(alive.map(a => a.camp))];
  if (camps.length === 1) return ROLE_NAME_OF_CAMP(camps[0], alive);
  return null;
}

function ROLE_NAME_OF_CAMP(camp: string, alive: { role: RoleId; camp: string }[]): string {
  const r = alive.find(a => a.camp === camp);
  return r ? ROLE[r.role].name : camp;
}

export const MODES: Record<number, ModeConfig> = {
  2: {
    id: "duel",
    name: "1v1",
    players: 2,
    roles: [ROLE.team_a, ROLE.team_b],
    teammateVisible: false,
    revealed: [],
    winnerCheck: campWinner,
  },
  3: {
    id: "doudizhu",
    name: "斗地主",
    players: 3,
    roles: [ROLE.lord, ROLE.farmer, ROLE.farmer],
    hp: { lord: 5, farmer: 4 },
    teammateVisible: true, // 农民互见
    revealed: ["lord"],
    winnerCheck: campWinner,
  },
  4: {
    id: "2v2",
    name: "2v2",
    players: 4,
    roles: [ROLE.team_a, ROLE.team_a, ROLE.team_b, ROLE.team_b],
    teammateVisible: true,
    revealed: [],
    winnerCheck: campWinner,
  },
  8: {
    id: "identity8",
    name: "军争八人身份场",
    players: 8,
    roles: [ROLE.zhu, ROLE.zhong, ROLE.zhong, ROLE.fan, ROLE.fan, ROLE.fan, ROLE.fan, ROLE.nei],
    hp: { zhu: 5 }, // 主公 +1 体力（标准规则）
    teammateVisible: false, // 身份场全保密（主公除外）
    revealed: ["zhu"],
    winnerCheck: alive => {
      const zhuAlive = alive.some(a => a.role === "zhu");
      if (!zhuAlive) {
        // 主公阵亡：内奸单挑全场获胜，否则反贼胜（标准规则）
        if (alive.length === 1 && alive[0].role === "nei") return "内奸";
        return "反贼";
      }
      if (!alive.some(a => a.role === "fan" || a.role === "nei")) return "主公方";
      return null;
    },
  },
  // 5 / 6 / 7 人：暂无模式（开局会被拒绝并提示）
};

export const ROLE_NAMES: Record<RoleId, string> = Object.fromEntries(
  Object.entries(ROLE).map(([k, v]) => [k, v.name]),
) as Record<RoleId, string>;

export function modeFor(count: number): ModeConfig | null {
  return MODES[count] ?? null;
}
