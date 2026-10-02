/* ============================================================
   wzbp · 服务端顺序蓝图（契约 §6）
   ------------------------------------------------------------
   1) 内置赛制镜像：必须与 js/draft.js 的 MODES 逐项一致，
      服务端只用它做「权威校验」与「回放渲染」，前端仍然自带一份。
   2) random 模式：ban 段与 pick 段各自洗牌，约束见契约 §6：
      · 每队 ban/pick 数不变（蓝 3 ban / 红 3 ban / 双方各 5 pick）
      · pick 段仍由蓝方先手
      · 不连续同队 3 手以上（即同队连击最多 2 手）

   步骤格式：{ s:'blue'|'red'|'both', a:'ban'|'pick', n?:number, p:'阶段名', t?:'副标题' }
   —— 与 js/draft.js 完全一致，'both' + n 表示「双方同时进行，各 n 手」。
   ============================================================ */
'use strict';

/* ---------------- 内置赛制（镜像 js/draft.js · MODES） ---------------- */

const RANKED_STEPS = [
  { s: 'blue', a: 'ban', p: '禁用阶段' },
  { s: 'red', a: 'ban', p: '禁用阶段' },
  { s: 'red', a: 'ban', p: '禁用阶段' },
  { s: 'blue', a: 'ban', p: '禁用阶段' },
  { s: 'blue', a: 'ban', p: '禁用阶段' },
  { s: 'red', a: 'ban', p: '禁用阶段' },

  { s: 'blue', a: 'pick', p: '第一轮选择', t: '蓝方一选' },
  { s: 'red', a: 'pick', p: '第一轮选择' },
  { s: 'red', a: 'pick', p: '第一轮选择' },
  { s: 'blue', a: 'pick', p: '第一轮选择' },
  { s: 'blue', a: 'pick', p: '第一轮选择' },
  { s: 'red', a: 'pick', p: '第二轮选择' },
  { s: 'red', a: 'pick', p: '第二轮选择' },
  { s: 'blue', a: 'pick', p: '第二轮选择' },
  { s: 'blue', a: 'pick', p: '第二轮选择' },
  { s: 'red', a: 'pick', p: '第二轮选择', t: '红方五楼' }
];

/* KPL 全局 BP：每队 5 ban + 5 pick，共 20 手。
   逐项镜像 js/draft.js 的 kpl steps（客户端是权威，改这里前先对齐客户端）。 */
const KPL_STEPS = [
  /* ---------- 第一轮 B2P3：4 ban（蓝2红2）+ 6 pick（红3蓝3），共 10 手 ---------- */
  { s: 'blue', a: 'ban', p: '第一轮禁用', t: '蓝方 ban 1' },
  { s: 'red', a: 'ban', p: '第一轮禁用', t: '红方 ban 1' },
  { s: 'red', a: 'ban', p: '第一轮禁用', t: '红方 ban 2' },
  { s: 'blue', a: 'ban', p: '第一轮禁用', t: '蓝方 ban 2' },
  { s: 'red', a: 'pick', p: '第一轮选择', t: '红方一选' },
  { s: 'blue', a: 'pick', p: '第一轮选择', t: '蓝方一选' },
  { s: 'blue', a: 'pick', p: '第一轮选择', t: '蓝方二选' },
  { s: 'red', a: 'pick', p: '第一轮选择', t: '红方二选' },
  { s: 'red', a: 'pick', p: '第一轮选择', t: '红方三选' },
  { s: 'blue', a: 'pick', p: '第一轮选择', t: '蓝方三选' },

  /* ---------- 第二轮 B3P2：6 ban（红3蓝3）+ 4 pick（红2蓝2），共 10 手 ---------- */
  { s: 'red', a: 'ban', p: '第二轮禁用', t: '红方 ban 3' },
  { s: 'blue', a: 'ban', p: '第二轮禁用', t: '蓝方 ban 3' },
  { s: 'blue', a: 'ban', p: '第二轮禁用', t: '蓝方 ban 4' },
  { s: 'red', a: 'ban', p: '第二轮禁用', t: '红方 ban 4' },
  { s: 'red', a: 'ban', p: '第二轮禁用', t: '红方 ban 5' },
  { s: 'blue', a: 'ban', p: '第二轮禁用', t: '蓝方 ban 5' },
  { s: 'red', a: 'pick', p: '第二轮选择', t: '红方四选' },
  { s: 'blue', a: 'pick', p: '第二轮选择', t: '蓝方四选' },
  { s: 'blue', a: 'pick', p: '第二轮选择', t: '蓝方五选' },
  { s: 'red', a: 'pick', p: '第二轮选择', t: '红方五选' }
];

const PEAK_STEPS = [
  { s: 'both', a: 'ban', n: 3, p: '禁用阶段', t: '双方同时禁用，各 3 个' },
  { s: 'blue', a: 'pick', p: '第一轮选择' },
  { s: 'red', a: 'pick', p: '第一轮选择' },
  { s: 'red', a: 'pick', p: '第一轮选择' },
  { s: 'blue', a: 'pick', p: '第一轮选择' },
  { s: 'blue', a: 'pick', p: '第一轮选择' },
  { s: 'red', a: 'pick', p: '第二轮选择' },
  { s: 'red', a: 'pick', p: '第二轮选择' },
  { s: 'blue', a: 'pick', p: '第二轮选择' },
  { s: 'blue', a: 'pick', p: '第二轮选择' },
  /* 最后一位必须是红方五楼，否则双方 pick 数不相等（5:4） */
  { s: 'red', a: 'pick', p: '第二轮选择', t: '红方五楼' }
];

/* 契约 §6：random 取「ranked 的 6 ban + 10 pick 配比」作为洗牌底稿 */
const RANDOM_BASE = RANKED_STEPS;

const MODES = {
  ranked: { id: 'ranked', name: '排位征召', steps: RANKED_STEPS },
  kpl: { id: 'kpl', name: '全局 BP', global: true, steps: KPL_STEPS },
  peak: { id: 'peak', name: '巅峰赛', steps: PEAK_STEPS },
  random: { id: 'random', name: '随机征召', steps: RANDOM_BASE }
};

const MODE_IDS = Object.keys(MODES);

/* ---------------- 小工具 ---------------- */

function cloneStep(st) {
  const o = { s: st.s, a: st.a, p: st.p || '' };
  if (st.t) o.t = st.t;
  if (st.n) o.n = Math.max(1, Math.trunc(st.n));
  return o;
}

/* 某一步需要几个侧别出手（'both' 表示双方各自出手） */
function sidesOfStep(st) { return st.s === 'both' ? ['blue', 'red'] : [st.s]; }

/* 某一步里每个侧别要出几手 */
function repeatOfStep(st) { return Math.max(1, Math.trunc(st.n || 1)); }

/* 一步总共要吃几手（'both' + n 时是 2n） */
function actionsOfStep(st) { return sidesOfStep(st).length * repeatOfStep(st); }

/* 每队的 ban/pick 容量 */
function capacities(steps) {
  const cap = { blue: { ban: 0, pick: 0 }, red: { ban: 0, pick: 0 } };
  const arr = steps || [];
  for (let i = 0; i < arr.length; i++) {
    const st = arr[i];
    const n = repeatOfStep(st);
    sidesOfStep(st).forEach(function (side) { cap[side][st.a] += n; });
  }
  return cap;
}

/* 清洗来自前端/数据库的蓝图：形状不对的条目直接丢掉 */
function sanitizeOrder(order) {
  if (!Array.isArray(order)) return null;
  const out = [];
  for (let i = 0; i < order.length; i++) {
    const st = order[i];
    if (!st || typeof st !== 'object') continue;
    const side = String(st.s || '');
    const act = String(st.a || '');
    if (side !== 'blue' && side !== 'red' && side !== 'both') continue;
    if (act !== 'ban' && act !== 'pick') continue;
    out.push(cloneStep({
      s: side, a: act,
      n: st.n, p: typeof st.p === 'string' ? st.p : '',
      t: typeof st.t === 'string' ? st.t : ''
    }));
  }
  return out.length ? out : null;
}

/* 蓝图总手数 */
function totalActions(order) {
  let n = 0;
  for (let i = 0; i < (order || []).length; i++) n += actionsOfStep(order[i]);
  return n;
}

/* 从动作流水推进蓝图下标：返回 { stepIndex, usedInStep, done }。
   语义与 js/draft.js 一致：'both' 步里双方各自出满 n 手才推进。 */
function stepIndexFrom(order, actions) {
  const arr = order || [];
  let idx = 0;
  let used = 0;
  const acts = actions || [];
  for (let i = 0; i < acts.length; i++) {
    if (idx >= arr.length) break;
    const need = actionsOfStep(arr[idx]);
    used += 1;
    if (used >= need) { idx += 1; used = 0; }
  }
  return { stepIndex: idx, usedInStep: used, done: idx >= arr.length };
}

/* ---------------- 随机洗牌（契约 §6） ---------------- */

function defaultRnd() { return Math.random(); }

function shuffled(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* 同队最多连击 2 手（契约：不连续同队 3 手以上）；'both' 视为中立，不参与连击 */
function runOk(sides, limit) {
  let run = 1;
  for (let i = 1; i < sides.length; i++) {
    if (sides[i] === 'both' || sides[i - 1] === 'both') { run = 1; continue; }
    if (sides[i] === sides[i - 1]) {
      run += 1;
      if (run > limit) return false;
    } else {
      run = 1;
    }
  }
  return true;
}

/* 确定性兜底：贪心「谁的余量多谁先上」，且避免连击超过 limit。
   随机采样失败时用它，保证洗牌永远返回合法结果。 */
function arrangeGreedy(sides, limit, first) {
  const rem = {};
  for (let i = 0; i < sides.length; i++) rem[sides[i]] = (rem[sides[i]] || 0) + 1;
  const out = [];
  let last = '';
  let run = 0;
  for (let i = 0; i < sides.length; i++) {
    const keys = Object.keys(rem).filter(function (k) { return rem[k] > 0; });
    if (!keys.length) break;
    let cand;
    if (i === 0 && first && rem[first] > 0) {
      cand = first;
    } else {
      /* 先排除会形成超长连击的选项 */
      let pool = keys.filter(function (k) { return !(k === last && run >= limit); });
      if (!pool.length) pool = keys;
      pool.sort(function (a, b) { return (rem[b] - rem[a]) || (a < b ? -1 : 1); });
      cand = pool[0];
      /* 能不连就不连，观感更均衡 */
      if (cand === last && pool.length > 1 && run >= 1) cand = pool[1];
    }
    out.push(cand);
    rem[cand] -= 1;
    if (cand === last) run += 1; else { run = 1; last = cand; }
  }
  return out;
}

/* 洗出一组合法顺序：先随机采样，失败则走确定性兜底 */
function arrange(sides, limit, first, rnd) {
  if (!sides.length) return [];
  const firstOk = function (a) { return !first || a[0] === first || a[0] === 'both'; };
  for (let attempt = 0; attempt < 3000; attempt++) {
    const cand = shuffled(sides, rnd);
    if (firstOk(cand) && runOk(cand, limit)) return cand;
  }
  const greedy = arrangeGreedy(sides, limit, first);
  if (firstOk(greedy) && runOk(greedy, limit)) return greedy;
  /* 理论上到不了这里；真到了就退化成「原样返回」，绝不产出非法蓝图 */
  return sides.slice();
}

/**
 * 洗牌：契约 §6。
 * @param {Array} base 底稿蓝图（默认按 ranked 的 6 ban + 10 pick 配比）
 * @param {Function} [rnd] 随机源（自检注入固定序列用）
 * @returns {Array} 新的蓝图数组（ban 段在前、pick 段在后）
 */
function shuffleOrder(base, rnd) {
  const src = sanitizeOrder(base) || RANDOM_BASE.map(cloneStep);
  const random = typeof rnd === 'function' ? rnd : defaultRnd;

  const banSteps = [];
  const pickSteps = [];
  for (let i = 0; i < src.length; i++) {
    (src[i].a === 'ban' ? banSteps : pickSteps).push(src[i]);
  }

  const banSides = arrange(banSteps.map(function (s) { return s.s; }), 2, null, random);
  /* pick 段仍以蓝方先手（契约 §6） */
  const pickSides = arrange(pickSteps.map(function (s) { return s.s; }), 2, 'blue', random);

  const out = [];
  for (let i = 0; i < banSides.length; i++) out.push({ s: banSides[i], a: 'ban', p: '禁用阶段', t: '' });
  for (let i = 0; i < pickSides.length; i++) out.push({ s: pickSides[i], a: 'pick', p: '选择阶段', t: '' });
  return out;
}

/**
 * 取某个赛制的顺序蓝图。
 * @param {string} mode ranked | kpl | peak | random
 * @returns {Array|null} 内置赛制返回镜像副本；random 返回一次洗牌结果；未知赛制返回 null
 */
function orderFor(mode) {
  const m = MODES[String(mode || '').toLowerCase()];
  if (!m) return null;
  if (m.id === 'random') return shuffleOrder(RANDOM_BASE);
  return m.steps.map(cloneStep);
}

function isMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODES, String(mode || '').toLowerCase());
}

/* 是否启用「全局 BP」（目前只有 kpl，对应 js/draft.js 里 mode.global=true）：
   本方在本系列赛选过的英雄，本方后续小局不能再选；对方不受影响；禁用不进池。 */
function isGlobal(mode) {
  const m = MODES[String(mode || '').toLowerCase()];
  return !!(m && m.global);
}

module.exports = {
  MODES,
  MODE_IDS,
  RANDOM_BASE,
  orderFor,
  shuffleOrder,
  isMode,
  isGlobal,
  capacities,
  totalActions,
  actionsOfStep,
  sidesOfStep,
  repeatOfStep,
  stepIndexFrom,
  sanitizeOrder,
  cloneStep
};
