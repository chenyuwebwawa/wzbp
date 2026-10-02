/* ============================================================
   wzbp · BP 引擎自检（Node 环境，不需要浏览器）
   ------------------------------------------------------------
   在 Node 里用 vm 伪造最小浏览器环境，加载 js/utils.js 与 js/draft.js，
   用假英雄数据跑完整赛制断言，验证：
     · 排位征召 16 步顺序（蓝1 → 红2 → 蓝2 → 红1 → 交替选人）
     · KPL 全局 BP 20 步顺序（含第二轮 ban）
     · 巅峰赛「双方同时禁用」的同步步骤语义
     · 回合校验 / 重复英雄拒绝 / 越权拒绝 / 侧别容量上限
     · 撤销、重做
     · 导出 → 导入 round-trip（含同步步骤的 ban 归属）
     · 分享码 round-trip
     · 搜索排序与分路过滤
   用法：node scripts/verify-engine.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else {
    fail++;
    failures.push(label + (extra ? ' — ' + extra : ''));
    console.log('  ✗ ' + label + (extra ? '  → ' + extra : ''));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, label, a === b ? '' : `实际 ${a} 期望 ${b}`);
}

function section(t) { console.log('\n[' + t + ']'); }

/* ---------- 伪造浏览器环境 ---------- */

const store = new Map();
const sandbox = {
  console,
  TextEncoder, TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { href: 'file:///index.html', hash: '' },
  navigator: { userAgent: 'node' },
  Image: class { constructor() { this.src = ''; } },
  document: {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    documentElement: { style: { setProperty() {} } }
  },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

/* ---------- 假英雄数据 ---------- */
/* 必须比最长赛制（巅峰赛 16 个动作）多，否则自动打满时会把可选池抽干 */
const N = 40;

sandbox.WZ = sandbox.WZ || {};
sandbox.WZ.HEROES = Array.from({ length: N }, (_, i) => ({
  id: 100 + i,
  name: '英雄' + (i + 1),
  title: '测试',
  idName: 'hero' + (i + 1),
  roles: ['中路'],
  types: ['法师'],
  pinyin: { full: 'hero' + (i + 1), initials: 'h' + (i + 1), variants: ['hero' + (i + 1), 'h' + (i + 1)] },
  avatar: 'x.jpg',
  splash: ['x.jpg'],
  skins: ['默认']
}));
sandbox.WZ.HERO_META = { generatedAt: 'test' };
sandbox.WZ.heroById = function (id) {
  return this.HEROES.filter((h) => String(h.id) === String(id))[0] || null;
};

load('js/utils.js');
load('js/draft.js');

const D = sandbox.WZ.draft;
const heroId = (n) => 100 + n;      // 第 n 个英雄（从 0 开始）

/* 按 steps 顺序自动打完一整局，返回执行的 (side, action, heroId) 列表 */
function autoPlay(modeId) {
  D.init(modeId);
  const rules = D.rules(modeId);
  const plan = [];
  const pool = Array.from({ length: N }, (_, i) => heroId(i));
  let pi = 0;
  for (const st of rules.steps) {
    const sides = st.s === 'both' ? ['blue', 'red'] : [st.s];
    const n = Math.max(1, st.n || 1);
    for (let r = 0; r < n; r++) {
      for (const side of sides) {
        if (D.state().done) break;
        const id = pool[pi++];
        const res = D.apply(side, st.a, id);
        if (!res.ok) throw new Error('自动执行失败：' + side + ' ' + st.a + ' → ' + res.reason);
        plan.push({ side, action: st.a, id });
      }
    }
  }
  return plan;
}

/* ============================================================ */
section('初始状态');
{
  D.init('ranked');
  const s = D.state();
  eq(s.step, 0, '初始 step = 0');
  eq(s.mode, 'ranked', '默认赛制 = ranked');
  eq(s.totalSteps, 16, '排位征召共 16 步');
  eq(s.pool.length, N, '初始可选池 = 全部英雄');
  eq(s.done, false, '初始未结束');
  eq(D.canAct('blue', 'ban'), true, '第一步蓝方可 ban');
  eq(D.canAct('red', 'ban'), false, '第一步红方不可 ban');
  eq(D.canAct('blue', 'pick'), false, '第一步不可 pick');
}

section('排位征召完整顺序（16 步）');
{
  const plan = autoPlay('ranked');
  eq(plan.length, 16, '共执行 16 步');
  const blueprint = plan.map((p) => (p.side === 'blue' ? 'B' : 'R') + p.action[0].toUpperCase()).join(',');
  eq(blueprint, [
    'BB', 'RB', 'RB', 'BB', 'BB', 'RB',      // 蓝1 → 红2 → 蓝2 → 红1
    'BP', 'RP', 'RP', 'BP', 'BP', 'RP', 'RP', 'BP', 'BP', 'RP'
  ].join(','), 'ban/pick 顺序与游戏内征召一致');

  const s = D.state();
  eq(s.done, true, '结束后 done = true');
  eq(s.bans.blue.length, 3, '蓝方 3 ban');
  eq(s.bans.red.length, 3, '红方 3 ban');
  eq(s.picks.blue.length, 5, '蓝方 5 pick');
  eq(s.picks.red.length, 5, '红方 5 pick');
  eq(s.pool.length, N - 16, '可选池减少 16');
  eq(D.apply('blue', 'pick', heroId(20)).ok, false, '结束后不能再操作');
}

section('回合 / 重复 / 非法校验');
{
  D.init('ranked');
  const a = D.apply('blue', 'ban', heroId(0));
  ok(a.ok, '蓝方 ban 第一步成功');
  const b = D.apply('blue', 'ban', heroId(1));
  eq(b.ok, false, '第二步不是蓝方 → 拒绝');
  eq(b.reason, '当前轮到红方', '拒绝原因正确');
  const c = D.apply('red', 'ban', heroId(0));
  eq(c.ok, false, '红方 ban 已被 ban 的英雄 → 拒绝');
  ok(/已被 ban\/pick/.test(c.reason), '重复原因含「已被 ban/pick」', c.reason);
  const d = D.apply('red', 'pick', heroId(1));
  eq(d.ok, false, 'ban 阶段不能 pick');
  const e = D.apply('red', 'ban', heroId(99999));
  eq(e.ok, false, '不存在的英雄 → 拒绝');
  ok(D.apply('red', 'ban', heroId(1)).ok, '红方 ban 合法英雄成功');
}

section('撤销 / 重做');
{
  autoPlay('ranked');
  const after = D.state();
  eq(after.step, 16, '打满 16 步');
  eq(after.canUndo, true, '可撤销');

  const u1 = D.undo();
  ok(u1.ok, '撤销 1 次成功');
  eq(D.state().step, 15, '撤销后 step = 15');
  eq(D.state().picks.red.length, 4, '撤销后红方只剩 4 pick');
  eq(D.state().pool.length, N - 15, '撤销后英雄回到可选池');

  D.undo(); D.undo();
  eq(D.state().step, 13, '连续撤销 3 次 → step = 13');

  const r1 = D.redo();
  ok(r1.ok, '重做成功');
  eq(D.state().step, 14, '重做后 step = 14');

  /* 撤销后再执行新动作，应截断重做链 */
  const st = D.state();
  D.apply(st.stepInfo.side === 'both' ? 'blue' : st.stepInfo.side, st.stepInfo.action, heroId(23));
  eq(D.state().canRedo, false, '撤销后执行新动作 → 重做链被截断');

  /* 一路撤销到底 */
  let guard = 0;
  while (D.state().canUndo && guard++ < 100) D.undo();
  eq(D.state().step, 0, '可以一直撤销到 0');
  eq(D.state().pool.length, N, '回到 0 步时可选池恢复');
  eq(D.undo().ok, false, '到底后不能再撤销');
}

section('全局 BP（每队 5 ban + 5 pick，20 手：先 ban2 后 ban3）');
{
  const plan = autoPlay('kpl');
  eq(plan.length, 20, '共执行 20 手');
  const blueprint = plan.map((p) => (p.side === 'blue' ? 'B' : 'R') + p.action[0].toUpperCase()).join(',');
  eq(blueprint, [
    /* 第一轮禁用：双方各 2 个（交替，蓝先） */
    'BB', 'RB', 'BB', 'RB',
    /* 第一轮选择：蓝P1 红P2 蓝P2 红P1 */
    'BP', 'RP', 'RP', 'BP', 'BP', 'RP',
    /* 第二轮禁用：双方各 3 个（交替，红先） */
    'RB', 'BB', 'RB', 'BB', 'RB', 'BB',
    /* 第二轮选择：红P1 蓝P2 红P1 */
    'RP', 'BP', 'BP', 'RP'
  ].join(','), '顺序为 先 ban2（蓝红蓝红）→ P1-2-2-1 → 后 ban3（红蓝红蓝红蓝）→ P1-2-1');

  /* 阶段边界 */
  const bans1 = plan.slice(0, 4);
  eq(bans1.length, 4, '第一轮禁用 4 个 ban（各 2）');
  eq(bans1.map((p) => (p.side === 'blue' ? 'B' : 'R')).join(''), 'BRBR', '第一轮禁用交替、蓝先');
  const picks1 = plan.slice(4, 10);
  eq(picks1.length, 6, '第一轮选择 6 手');
  eq(picks1.map((p) => (p.side === 'blue' ? 'B' : 'R')).join(''), 'BRRBBR',
    '第一轮 pick 是 蓝P1 红P2 蓝P2 红P1（BRRBBR）');
  const bans2 = plan.slice(10, 16);
  eq(bans2.length, 6, '第二轮禁用 6 个 ban（各 3）');
  eq(bans2.map((p) => (p.side === 'blue' ? 'B' : 'R')).join(''), 'RBRBRB', '第二轮禁用交替、红先');
  const picks2 = plan.slice(16);
  eq(picks2.map((p) => (p.side === 'blue' ? 'B' : 'R')).join(''), 'RBBR',
    '第二轮 pick 是 红P1 蓝P2 红P1（RBBR）');

  const s = D.state();
  eq(s.cap.blue.ban, 5, '蓝方 5 个 ban 位');
  eq(s.cap.red.ban, 5, '红方 5 个 ban 位');
  eq(s.cap.blue.pick, 5, '蓝方 5 个 pick 位');
  eq(s.cap.red.pick, 5, '红方 5 个 pick 位');
  eq(s.bans.blue.length, 5, '蓝方 ban 数 = 5（先 2 后 3）');
  eq(s.bans.red.length, 5, '红方 ban 数 = 5（先 2 后 3）');
  eq(s.picks.blue.length, 5, '蓝方 pick 数 = 5');
  eq(s.picks.red.length, 5, '红方 pick 数 = 5');
  eq(s.bans.blue.length + s.bans.red.length, 10, '共 10 ban');
  eq(s.picks.blue.length + s.picks.red.length, 10, '共 10 pick');
  eq(s.done, true, '能正常走完');
  eq(s.global, true, '标记为全局 BP 赛制');
}

section('赛制顺序与服务端镜像逐项一致（防止两边漂移）');
{
  /* 服务端在 server/draft.js 里镜像了一份顺序，两边不一致会导致整局都对不上。
     这里直接把两份读出来对比，而不是只靠人眼。 */
  const fs = await import('node:fs');
  const srv = fs.readFileSync('server/draft.js', 'utf8');
  const m = srv.match(/const KPL_STEPS = \[([\s\S]*?)\n\];/);
  ok(!!m, '能从 server/draft.js 里读到 KPL_STEPS');
  if (m) {
    const srvSteps = [...m[1].matchAll(/\{\s*s:\s*'(\w+)',\s*a:\s*'(\w+)'/g)]
      .map((x) => x[1] + ':' + x[2]);
    const cliSteps = D.MODES.find((x) => x.id === 'kpl').steps.map((x) => x.s + ':' + x.a);
    eq(srvSteps.join(','), cliSteps.join(','), '服务端 kpl 顺序与客户端逐项一致');
    eq(srvSteps.length, 20, '服务端也是 20 步');
  }
}

section('全局 BP 池：本方选过的英雄本方不能再选');
{
  D.init('kpl');
  /* 模拟服务端下发「蓝方上一局用过 105」 */
  D.setGlobalUsed({ blue: [105], red: [] });

  /* 走到 pick 阶段：把第一轮 6 个 ban 落掉。
     注意要用**池尾**的英雄，别把断言要用的 105 / heroId(30/31) 提前消耗掉。 */
  let guard = 0;
  while (D.state().stepInfo && D.state().stepInfo.action !== 'pick' && guard++ < 10) {
    const s = D.state();
    D.apply(s.stepInfo.side, s.stepInfo.action, s.pool[s.pool.length - 1]);
  }
  eq(D.state().stepInfo.action, 'pick', '进入 pick 阶段');

  /* 现在轮到 蓝P1（新顺序第一轮选择是蓝方先手）——
     105 是蓝方上一局用过的，应被全局池挡住 */
  const blocked = D.apply('blue', 'pick', 105);
  eq(blocked.ok, false, '蓝方不能选自己上一局用过的英雄');
  ok(/全局 BP/.test(blocked.reason || ''), '拒绝原因点明全局 BP', blocked.reason || '');

  /* 落掉蓝方这一手，轮到红方 */
  D.apply('blue', 'pick', heroId(30));
  eq(D.state().stepInfo.side, 'red', '蓝方落子后轮到红方');

  /* 单边限制：红方用过的英雄，蓝方之后仍可以选 */
  D.setGlobalUsed({ blue: [105], red: [heroId(30)] });
  const redPick = D.apply('red', 'pick', heroId(31));
  ok(redPick.ok, '红方可以选（31 未被全局池占用）', redPick.reason || '');
  const blueNext = D.apply('red', 'pick', heroId(32));
  ok(blueNext.ok, '红P2 的第二手也能落', blueNext.reason || '');

  /* 全局池不限制 ban */
  D.init('kpl');
  D.setGlobalUsed({ blue: [105], red: [] });
  const banOk = D.apply('blue', 'ban', 105);
  ok(banOk.ok, '全局池不限制禁用（禁用只在本局生效）', banOk.reason || '');

  /* 快照带全局池供 UI 标灰 */
  eq(D.state().globalUsed.blue, [105], '状态里带全局池供 UI 使用');
  D.setGlobalUsed({ blue: [], red: [] });
  eq(D.state().globalUsed.blue, [], '可以清空全局池');
}

section('巅峰赛（双方同时禁用）');
{
  D.init('peak');
  const s0 = D.state();
  eq(s0.totalSteps, 11, '巅峰赛共 11 步（1 个同步 ban 阶段 + 10 个 pick）');
  eq(s0.cap.blue.ban, 3, 'cap：蓝方 3 个 ban 位（同步步骤按 n 计入）');
  eq(s0.cap.red.ban, 3, 'cap：红方 3 个 ban 位');

  /* 同一个「双方同时」步骤里蓝红各出 3 手，全部落位后步数才 +1 */
  let poolIdx = 0;
  const pid = () => heroId(poolIdx++);
  for (let i = 0; i < 3; i++) {
    const a = D.apply('blue', 'ban', pid());
    const b = D.apply('red', 'ban', pid());
    ok(a.ok && b.ok, `同步禁用第 ${i + 1} 轮：蓝红都能出手`, a.reason || b.reason || '');
    /* 最后一轮落下时同步步骤就完成了，此时应当已经推进到下一步 */
    eq(D.state().step, i < 2 ? 0 : 1,
      `同步禁用第 ${i + 1} 轮后 step = ${i < 2 ? 0 : 1}`);
  }
  eq(D.state().step, 1, '双方各出满 3 手后才推进到 pick 阶段');
  eq(D.state().bans.blue.length, 3, '蓝方 3 ban');
  eq(D.state().bans.red.length, 3, '红方 3 ban');
  const over = D.apply('blue', 'ban', pid());
  eq(over.ok, false, '同步阶段蓝方第 4 手被拒绝（ban 位已满）');

  /* 打完剩下的 pick */
  let guard = 0;
  while (!D.state().done && guard++ < 30) {
    const s = D.state();
    const side = s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side;
    const r = D.apply(side, s.stepInfo.action, s.pool[0]);
    if (!r.ok) throw new Error('巅峰赛自动执行失败：' + r.reason);
  }
  const e = D.state();
  eq(e.done, true, '巅峰赛能正常走完');
  eq(e.picks.blue.length, 5, '蓝方 5 pick');
  eq(e.picks.red.length, 5, '红方 5 pick');
  eq(e.stepSides.length, 16, 'stepSides 记录了 6 个 ban + 10 个 pick');

  /* 导出：ban 的归属必须正确（同步步骤最容易出错的地方） */
  const dump = D.exportData();
  eq(dump.actions.length, 16, '导出 16 个动作');
  const bans = dump.actions.filter((a) => a.a === 'ban');
  eq(bans.filter((a) => a.s === 'blue').length, 3, '导出中蓝方 3 个 ban');
  eq(bans.filter((a) => a.s === 'red').length, 3, '导出中红方 3 个 ban');
  eq(dump.actions.filter((a) => a.a === 'pick').length, 10, '导出中 10 个 pick');

  D.init('ranked');
  const imp = D.importData(JSON.parse(JSON.stringify(dump)));
  ok(imp.ok, '巅峰赛导出可导入');
  eq(imp.skipped, 0, '巅峰赛导入无步骤被跳过');
  eq(D.state().mode, 'peak', '导入后赛制正确');
  eq(D.state().bans, e.bans, '导入后 ban 一致');
  eq(D.state().picks, e.picks, '导入后 pick 一致');
}

section('导出 → 导入 round-trip（两种赛制）');
{
  for (const mode of ['ranked', 'kpl']) {
    autoPlay(mode);
    const before = D.state();
    const dump = D.exportData();
    eq(dump.actions.length, before.step, mode + '：导出动作数 = 已完成步数');

    D.init('ranked');                      // 故意切到别的赛制再导入
    const res = D.importData(dump);
    ok(res.ok, mode + '：导入成功');
    eq(res.skipped, 0, mode + '：无步骤被跳过');
    const after = D.state();
    eq(after.mode, mode, mode + '：赛制还原');
    eq(after.step, before.step, mode + '：步数还原');
    eq(after.bans, before.bans, mode + '：ban 列表一致');
    eq(after.picks, before.picks, mode + '：pick 列表一致');
  }
}

section('畸形导入数据不应抛异常');
{
  const bad = [
    null, undefined, {}, [], 'string', 42,
    { app: 'other', actions: [] },
    { app: 'wzbp', mode: 'nope', actions: [] },
    { app: 'wzbp', mode: 'ranked', actions: 'notarray' },
    { app: 'wzbp', mode: 'ranked', actions: [{ s: 'blue', a: 'ban', id: 999999 }] },
    { app: 'wzbp', mode: 'ranked', actions: [{ s: 'red', a: 'ban', id: heroId(0) }] }
  ];
  let threw = 0;
  bad.forEach((b) => {
    try { D.importData(b); } catch (err) { threw++; console.log('    ' + JSON.stringify(b) + ' 抛错：' + err.message); }
  });
  eq(threw, 0, '畸形输入全部安全返回（未抛未捕获异常）');
}

section('巅峰赛中途导出 / 恢复（回归：动作流水必须无损）');
{
  /* 场景来自独立验收发现的缺陷：ban 阶段只占 1 步，
     旧的「按轮次摊平」实现会丢动作并造出 id=null 的幽灵动作。 */
  D.init('peak');
  D.apply('blue', 'ban', heroId(0));
  D.apply('blue', 'ban', heroId(1));
  D.apply('blue', 'ban', heroId(2));
  D.apply('red', 'ban', heroId(3));          // 故意只出 1 手，轮次不满
  const mid = D.state();
  eq(mid.step, 0, 'ban 阶段走到一半时 step 仍是 0（同步步骤的特性）');
  eq(mid.progress, 4, 'progress 反映真实进度 = 4 个动作');

  const dump = D.exportData();
  eq(dump.actions.length, 4, '中途导出动作数 = 4（不丢动作）');
  eq(dump.actions.map((a) => a.id), [heroId(0), heroId(1), heroId(2), heroId(3)],
    '导出动作的英雄 id 序列正确，且没有 null 幽灵动作');
  eq(dump.actions.map((a) => a.s), ['blue', 'blue', 'blue', 'red'], '导出动作归属正确');

  const code = D.shareCode();
  D.init('ranked');
  const back = D.applyShareCode(code);
  ok(back.ok, '巅峰赛中途分享码可还原');
  eq(D.state().bans.blue, [heroId(0), heroId(1), heroId(2)], '分享码还原后蓝方 3 个 ban 一个不少');
  eq(D.state().bans.red, [heroId(3)], '分享码还原后红方 1 个 ban');
  eq(D.state().progress, 4, '分享码还原后动作数一致');

  /* 中途导出 → 继续打完，再导出，动作总数应等于总动作数 */
  D.init('peak');
  for (let i = 0; i < 3; i++) { D.apply('blue', 'ban', heroId(i)); D.apply('red', 'ban', heroId(10 + i)); }
  let g = 0;
  while (!D.state().done && g++ < 30) {
    const s = D.state();
    D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]);
  }
  eq(D.exportData().actions.length, 16, '打满后导出 16 个动作');
}

section('导入畸形数据不应破坏当前 BP');
{
  D.init('ranked');
  D.apply('blue', 'ban', heroId(0));
  D.apply('red', 'ban', heroId(1));
  const before = D.state();
  eq(before.progress, 2, '先做一个 2 步的 BP 作为「现状」');

  const bad = [
    {}, [], null, undefined, 'string', 42,
    { app: 'other', actions: [] },
    { actions: [] },
    { bans: {}, picks: {} }
  ];
  bad.forEach((b) => {
    const r = D.importData(b);
    eq(r.ok, false, '畸形数据被拒绝：' + JSON.stringify(b));
  });
  eq(D.state().progress, 2, '拒绝之后当前 BP 仍然是 2 步（没被清空）');
  eq(D.state().bans.blue, before.bans.blue, '当前 BP 的 ban 没被改动');

  /* 未知赛制必须报错，而不是静默回落成排位征召 */
  const unknown = D.importData({ app: 'wzbp', mode: 'foo', actions: [{ s: 'blue', a: 'ban', id: heroId(5) }] });
  eq(unknown.ok, false, '未知赛制被拒绝');
  ok(/未知赛制/.test(unknown.reason || ''), '错误信息点明赛制未知', unknown.reason || '');
  eq(D.state().progress, 2, '未知赛制被拒后当前 BP 未变');

  /* 合法数据仍然要能导入 */
  const good = D.importData({
    app: 'wzbp', mode: 'ranked',
    actions: [{ s: 'blue', a: 'ban', id: heroId(7) }, { s: 'red', a: 'ban', id: heroId(8) }]
  });
  ok(good.ok && good.applied === 2, '合法数据仍能正常导入', 'applied=' + (good.applied));
}

section('分享码 round-trip');
{
  autoPlay('kpl');
  const before = D.state();
  const code = D.shareCode();
  ok(/^[A-Za-z0-9\-_]+$/.test(code), '分享码是 URL 安全字符', code.slice(0, 24) + '…');
  D.init('ranked');
  const res = D.applyShareCode(code);
  ok(res.ok, '分享码解析成功');
  const after = D.state();
  eq(after.mode, before.mode, '分享码还原赛制');
  eq(after.step, before.step, '分享码还原步数');
  eq(after.picks, before.picks, '分享码还原 pick');
  eq(after.bans, before.bans, '分享码还原 ban');
  eq(D.applyShareCode('这不是合法的码!!!').ok, false, '非法分享码被拒绝');
}

section('搜索（utils.searchHeroes）');
{
  /* 换成能体现中文/拼音区分的假数据 */
  sandbox.WZ.HEROES = [
    { id: 105, name: '廉颇', title: 't', idName: 'lianpo', roles: ['对抗路'], types: ['坦克'],
      pinyin: { full: 'lianpo', initials: 'lp', idName: 'lianpo', variants: ['lp', 'lianpo'] }, avatar: '', splash: [], skins: [] },
    { id: 109, name: '妲己', title: 't', idName: 'daji', roles: ['中路'], types: ['法师'],
      pinyin: { full: 'daji', initials: 'dj', idName: 'daji', variants: ['dj', 'daji'] }, avatar: '', splash: [], skins: [] },
    { id: 131, name: '李白', title: 't', idName: 'libai', roles: ['打野'], types: ['刺客'],
      pinyin: { full: 'libai', initials: 'lb', idName: 'libai', variants: ['libai', 'lb'] }, avatar: '', splash: [], skins: [] }
  ];
  const S = sandbox.WZ.util.searchHeroes;
  eq(S('廉颇').map((h) => h.name), ['廉颇'], '中文名精确搜索');
  eq(S('廉').map((h) => h.name), ['廉颇'], '中文单字搜索');
  eq(S('lianpo').map((h) => h.name), ['廉颇'], '全拼搜索');
  eq(S('lp').map((h) => h.name), ['廉颇'], '首字母搜索');
  eq(S('LP').map((h) => h.name), ['廉颇'], '首字母大写也命中');
  eq(S('libai').map((h) => h.name), ['李白'], '拼音命中');
  eq(S('').length, 3, '空查询返回全部');
  eq(S('', { role: '中路' }).map((h) => h.name), ['妲己'], '分路过滤');
  eq(S('', { role: '坦克' }).map((h) => h.name), ['廉颇'], '定位（types）也能过滤');
  eq(S('不存在的英雄').length, 0, '无结果返回空数组');
}

/* ============================================================ */
console.log('\n' + '='.repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log('  · ' + f));
  process.exitCode = 1;
} else {
  console.log('引擎自检全部通过 ✓');
}
