/* ============================================================
   wzbp · BP 规则引擎
   ------------------------------------------------------------
   数据驱动的赛制定义：每个模式就是一张 steps 表，
   引擎只负责「按顺序执行 + 校验 + 撤销重做 + 导入导出」。
   想改 ban/pick 顺序，只改 MODES 里的 steps 即可，
   其余代码（渲染、撤销、导出）不需要动。
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var MAX_HISTORY = 200;

  /* ------------------------------------------------------------
     赛制定义
     ------------------------------------------------------------
     每步格式：{ s: 'blue'|'red', a: 'ban'|'pick', p: '阶段名', t: '阶段副标题' }

     · ranked  排位征召：6 ban + 10 pick = 16 步（与游戏内征召一致）
     · kpl     KPL 全局 BP：3+3 ban、6 pick、2+2 ban、4 pick = 20 步
     · peak    巅峰赛：6 ban + 10 pick，但 ban 阶段双方同时进行（10 步）

     说明：KPL 第二轮 ban 的顺序各赛事/赛季略有差异，
     这里采用「红→蓝→蓝→红」（双方各 2 个）。如需调整，
     只改下面 kpl 的 steps 数组即可。 */

  var MODES = [
    {
      id: 'ranked',
      name: '排位征召',
      short: '征召',
      desc: '6 ban + 10 pick，与游戏内排位征召顺序一致：蓝1 → 红2 → 蓝2 → 红1，随后蓝红交替选人。',
      steps: [
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
      ]
    },
    {
      id: 'kpl',
      /* 界面标题就叫「全局 BP」；B2P3→B3P2 的细节放 desc，不占标题 */
      name: '全局 BP',
      short: '全局BP',
      desc: '每队 5 ban + 5 pick，共 20 手：第一轮 B2P3（双方各 ban 2 个 → 各选 3 个），第二轮 B3P2（双方各 ban 3 个 → 各选 2 个）。' +
            '全局 BP：同一系列赛里，本方选过的英雄，本方后续小局不能再选（对方不受影响）；禁用只在本局生效。',
      global: true,
      steps: [
        /* ---------- 第一轮：B2P3（双方各 ban 2 个 → 各选 3 个，共 10 手） ---------- */
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

        /* ---------- 第二轮：B3P2（双方各 ban 3 个 → 各选 2 个，共 10 手） ---------- */
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
      ]
    },
    {
      id: 'peak',
      name: '巅峰赛',
      short: '巅峰',
      desc: '双方禁用同时进行（各 3 个，占 1 步），随后蓝红交替选人，共 11 步；单人直播时更省操作。',
      steps: [
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
      ],
      experimental: true
    },
    {
      id: 'random',
      name: '随机征召',
      short: '随机',
      desc: '顺序随机：ban 位与 pick 位的先后手每局洗牌（双方 ban/pick 数量不变、pick 仍由蓝方先手），英雄仍由人手动选。联网开房间时由服务端洗牌并全房间共享；也支持用 setOrder() 注入自定义顺序。',
      /* 兜底顺序：与排位征召一致。真正生效的是 setOrder() 注入的洗牌结果，
         这里是「还没拿到蓝图」时的默认值，保证引擎任何时刻都可用。 */
      steps: [
        { s: 'blue', a: 'ban', p: '禁用阶段' },
        { s: 'red', a: 'ban', p: '禁用阶段' },
        { s: 'red', a: 'ban', p: '禁用阶段' },
        { s: 'blue', a: 'ban', p: '禁用阶段' },
        { s: 'blue', a: 'ban', p: '禁用阶段' },
        { s: 'red', a: 'ban', p: '禁用阶段' },
        { s: 'blue', a: 'pick', p: '第一轮选择' },
        { s: 'red', a: 'pick', p: '第一轮选择' },
        { s: 'red', a: 'pick', p: '第一轮选择' },
        { s: 'blue', a: 'pick', p: '第一轮选择' },
        { s: 'blue', a: 'pick', p: '第一轮选择' },
        { s: 'red', a: 'pick', p: '第二轮选择' },
        { s: 'red', a: 'pick', p: '第二轮选择' },
        { s: 'blue', a: 'pick', p: '第二轮选择' },
        { s: 'blue', a: 'pick', p: '第二轮选择' },
        { s: 'red', a: 'pick', p: '第二轮选择' }
      ]
    }
  ];

  /* 随机征召用的「自定义顺序」：
     联网模式下由服务端下发蓝图，这里存一份覆盖 MODES 里的 steps。
     结构必须与 steps 一致，且数量/侧别配比由服务端保证。 */
  var orderOverride = null;

  /* 注入自定义顺序（随机征召）。传 null 清除。
     注意会重置当前进度——顺序变了，已走的手数就没意义了。 */
  function setOrder(steps) {
    if (!steps || !steps.length) { orderOverride = null; return false; }
    orderOverride = steps.map(function (st) {
      var o = { s: st.s, a: st.a, p: st.p || '' };
      if (st.t) o.t = st.t;
      if (st.n) o.n = st.n;
      return o;
    });
    return true;
  }

  /* 取「当前真正生效的」顺序：有自定义蓝图就用它 */
  function activeSteps(mode) {
    if (mode.id === 'random' && orderOverride) return orderOverride;
    return mode.steps;
  }

  /* 当前是否全局 BP：内置赛制看 mode.global，自定义蓝图看注入时的 opts.global */
  function activeGlobalFlags(mode) {
    return !!(mode.global || (mode.id === 'random' && orderOverride && orderOverrideGlobal));
  }

  function modeById(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return MODES[0];
  }

  /* 严格查找：找不到返回 null（用于导入校验，避免把未知赛制静默当成排位征召） */
  function modeByIdStrict(id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i];
    return null;
  }

  /* ------------------------------------------------------------
     全局 BP 池
     ------------------------------------------------------------
     规则（依据 KPL 全局 BP）：**单边限制**
       · 本方在本系列赛选过的英雄，本方后续小局不能再选
       · 对方选过的英雄，本方不受影响
       · 禁用只在本局生效，不进全局池
     联网模式下由服务端下发（它还负责权威校验），这里只为本地/离线场景兜底。 */
  var globalUsed = { blue: [], red: [] };
  /* 注入自定义顺序时，是否也开启全局 BP（服务端下发的蓝图会带这个信息） */
  var orderOverrideGlobal = false;

  function setGlobalUsed(u) {
    globalUsed = {
      blue: (u && u.blue ? u.blue : []).slice(),
      red: (u && u.red ? u.red : []).slice()
    };
  }

  /* 某英雄对某侧是否已被「全局禁用」（本方选过） */
  function blockedByGlobal(side, heroId) {
    var list = globalUsed[side] || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]) === String(heroId)) return true;
    }
    return false;
  }

  function sidesOfStep(st) { return st.s === 'both' ? ['blue', 'red'] : [st.s]; }

  /* 某一步里每个侧别要出几手（st.n 默认 1） */
  function repeatOfStep(st) { return Math.max(1, st.n || 1); }

  /* 每个模式侧别容量：ban / pick 各多少个。
     按「SidesOfStep × repeat」累加——'both' + n:3 的步骤，
     双方各占 3 个 ban 位，否则巅峰赛的 ban 位容量会被算成 1。 */
  function capacities(mode) {
    var cap = { blue: { ban: 0, pick: 0 }, red: { ban: 0, pick: 0 } };
    activeSteps(mode).forEach(function (st) {
      var n = repeatOfStep(st);
      sidesOfStep(st).forEach(function (side) { cap[side][st.a] += n; });
    });
    return cap;
  }

  /* ------------------------------------------------------------
     状态
     ------------------------------------------------------------ */

  var listeners = [];
  var pending = { blue: {}, red: {} };   // 预选（不进入历史）

  var st = null;      // 当前状态
  var history = [];   // 历史快照
  var cursor = -1;    // 当前快照下标

  function blankState(modeId) {
    var mode = modeById(modeId);
    var cap = capacities(mode);
    return {
      mode: mode.id,
      step: 0,
      bans: { blue: [], red: [] },
      picks: { blue: [], red: [] },
      /* 每一步实际由哪一侧完成（导出时用来还原归属） */
      stepSides: [],
      /* 当前步骤已经出手的侧别（'both' 步骤要两侧都出手才推进） */
      stepDone: [],
      /* 逐个动作的执行流水：导出/恢复的唯一权威来源。
         巅峰赛的 ban 阶段整个只占 1 步，光看 step 无法还原「谁先谁后」。 */
      applied: [],
      pool: [],
      done: false,
      cap: cap
    };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function taken(heroId) {
    var id = String(heroId);
    var sides = ['blue', 'red'], i, j;
    for (i = 0; i < sides.length; i++) {
      for (j = 0; j < st.bans[sides[i]].length; j++) {
        if (String(st.bans[sides[i]][j]) === id) return true;
      }
      for (j = 0; j < st.picks[sides[i]].length; j++) {
        if (String(st.picks[sides[i]][j]) === id) return true;
      }
    }
    return false;
  }

  function recompute() {
    var all = WZ.HEROES || [];
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!taken(all[i].id)) out.push(all[i].id);
    }
    st.pool = out;
    st.done = st.step >= activeSteps(modeById(st.mode)).length;
    return st;
  }

  function snapshot() { return clone(st); }

  function restore(snap) {
    st = clone(snap);
    pending = { blue: {}, red: {} };
    emit();
  }

  function commit() {
    history = history.slice(0, cursor + 1);
    history.push(snapshot());
    if (history.length > MAX_HISTORY) history.shift();
    cursor = history.length - 1;
  }

  function emit() {
    var s = snapshotState();
    listeners.forEach(function (fn) {
      try { fn(s); } catch (e) { console.error('[draft] listener error', e); }
    });
  }

  /* 对外只读快照 */
  function snapshotState() {
    /* 引擎还没 init 时也要能安全调用：任何渲染方在启动早期读状态都不该炸 */
    if (!st) return null;
    var mode = modeById(st.mode);
    var steps = activeSteps(mode);
    var cur = st.step < steps.length ? steps[st.step] : null;
    var next = (st.step + 1) < steps.length ? steps[st.step + 1] : null;
    return {
      mode: mode.id,
      modeName: mode.name,
      modeDesc: mode.desc,
      step: st.step,
      totalSteps: steps.length,
      /* 已执行的动作数。巅峰赛 ban 阶段整个只占 1 步，
         所以判「有没有进度」必须看这个，不能看 step。 */
      progress: st.applied.length,
      stepInfo: cur ? { side: cur.s, action: cur.a, phase: cur.p, tip: cur.t || '' } : null,
      nextInfo: next ? { side: next.s, action: next.a, phase: next.p, tip: next.t || '' } : null,
      bans: { blue: st.bans.blue.slice(), red: st.bans.red.slice() },
      picks: { blue: st.picks.blue.slice(), red: st.picks.red.slice() },
      stepSides: st.stepSides.slice(),
      stepDone: st.stepDone.slice(),
      /* 全局 BP 池 + 是否全局 BP，供 UI 把「本方已用」的英雄标出来 */
      global: activeGlobalFlags(mode),
      globalUsed: { blue: globalUsed.blue.slice(), red: globalUsed.red.slice() },
      pool: st.pool.slice(),
      done: st.done,
      cap: st.cap,
      canUndo: cursor > 0,
      canRedo: cursor < history.length - 1,
      historyLen: history.length
    };
  }

  /* ------------------------------------------------------------
     对外 API
     ------------------------------------------------------------ */

  var api = {};

  api.MODES = MODES;
  api.modeById = modeById;

  /* 随机征召：注入服务端下发的顺序蓝图（或 null 清除）。
     会让当前进度作废——顺序变了，已走的手数不再对应，所以内部会 reset。
     opts.global 为 true 时同时开启全局 BP 校验。 */
  api.setOrder = function (steps, modeId, opts) {
    var ok = setOrder(steps);
    orderOverrideGlobal = !!(opts && opts.global);
    if (ok) api.init(modeId || (st ? st.mode : 'random'));
    return ok;
  };
  api.hasCustomOrder = function () { return !!orderOverride; };
  api.customOrder = function () { return orderOverride ? orderOverride.slice() : null; };

  /* 全局 BP 池（联网时由服务端下发；离线时可手动设置用于演示） */
  api.setGlobalUsed = function (used) {
    setGlobalUsed(used);
    emit();
    return globalUsed;
  };
  api.globalUsed = function () {
    return { blue: globalUsed.blue.slice(), red: globalUsed.red.slice() };
  };
  /* 当前赛制是否为全局 BP */
  api.isGlobal = function () {
    return !!(st && modeById(st.mode).global) || !!orderOverrideGlobal;
  };

  api.init = function (modeId) {
    st = blankState(modeId || MODES[0].id);
    recompute();                    // 先把可选池算出来，再做初始快照
    history = [snapshot()];
    cursor = 0;
    emit();
    return snapshotState();
  };

  api.reset = function (modeId) {
    return api.init(modeId || (st ? st.mode : MODES[0].id));
  };

  api.state = function () { return snapshotState(); };
  api.rules = function (modeId) { return modeById(modeId || (st ? st.mode : MODES[0].id)); };

  api.on = function (fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  /* 当前步骤是否允许该侧执行该动作 */
  api.canAct = function (side, action) {
    if (st.done) return false;
    var cur = activeSteps(modeById(st.mode))[st.step];
    if (!cur) return false;
    if (cur.a !== action) return false;
    if (cur.s === 'both') return side === 'blue' || side === 'red';
    return cur.s === side;
  };

  /* 当前步骤是否正在等待「任一方」行动（巅峰赛 ban 阶段） */
  api.isOpenStep = function () {
    if (st.done) return false;
    return activeSteps(modeById(st.mode))[st.step].s === 'both';
  };

  /* 校验并执行一步。失败返回 {ok:false, reason} */
  api.apply = function (side, action, heroId) {
    if (st.done) return { ok: false, reason: '本轮 BP 已结束' };
    var cur = activeSteps(modeById(st.mode))[st.step];
    if (!cur) return { ok: false, reason: '步骤越界' };
    if (cur.a !== action) return { ok: false, reason: '当前是' + (cur.a === 'ban' ? '禁用' : '选择') + '阶段' };
    if (cur.s !== 'both' && cur.s !== side) {
      return { ok: false, reason: '当前轮到' + (cur.s === 'blue' ? '蓝方' : '红方') };
    }
    /* 双方同步的步骤里，同一方只能出一手 */
    var repeat = repeatOfStep(cur);
    if (st.stepDone.indexOf(side) !== -1) {
      var doneCount = st.stepDone.filter(function (x) { return x === side; }).length;
      if (doneCount >= repeat) {
        return { ok: false, reason: (side === 'blue' ? '蓝方' : '红方') + '本步已经出满 ' + repeat + ' 手' };
      }
    }
    /* 每个侧别的 ban/pick 上限（防止赛制表配置错误时越界写入） */
    var cap = st.cap[side][cur.a];
    var used = cur.a === 'ban' ? st.bans[side].length : st.picks[side].length;
    if (used >= cap) {
      return { ok: false, reason: (side === 'blue' ? '蓝方' : '红方') + '的' +
        (cur.a === 'ban' ? '禁用' : '选择') + '位已满（' + cap + ' 个）' };
    }
    if (!WZ.util.heroById(heroId)) return { ok: false, reason: '英雄不存在' };
    if (taken(heroId)) {
      var h = WZ.util.heroById(heroId);
      return { ok: false, reason: (h ? h.name : '该英雄') + ' 已被 ban/pick' };
    }
    /* 全局 BP：本方在之前小局选过的英雄，本方不能再选（对方不受影响）；
       禁用不受全局池限制。 */
    var globalOn = !!modeById(st.mode).global || !!orderOverrideGlobal;
    if (globalOn && action === 'pick' && blockedByGlobal(side, heroId)) {
      var hg = WZ.util.heroById(heroId);
      return {
        ok: false,
        reason: (hg ? hg.name : '该英雄') + ' 已被' + (side === 'blue' ? '蓝方' : '红方') + '在之前的小局选用（全局 BP）'
      };
    }

    if (action === 'ban') st.bans[side].push(heroId);
    else st.picks[side].push(heroId);

    /* 记录到执行流水：这是导出与跨窗口同步的唯一权威来源。
       不能靠「按动作类型流水线取下标」还原——巅峰赛 ban 阶段里
       同一侧会连出 3 手，且中途导出时轮次可能不满。 */
    st.applied.push({ step: st.step, s: side, a: action, id: heroId });
    st.stepSides.push(side);
    st.stepDone.push(side);

    /* 'both' 步骤：每一侧都要出手 repeat 次，全部满足才推进 */
    var need = sidesOfStep(cur);
    var allDone = need.every(function (x) {
      return st.stepDone.filter(function (y) { return y === x; }).length >= repeat;
    });
    if (allDone) {
      st.step += 1;
      st.stepDone = [];
    }

    recompute();
    commit();
    emit();
    return { ok: true, state: snapshotState() };
  };

  api.undo = function () {
    if (cursor <= 0) return { ok: false, reason: '没有可撤销的步骤' };
    cursor -= 1;
    restore(history[cursor]);
    return { ok: true };
  };

  api.redo = function () {
    if (cursor >= history.length - 1) return { ok: false, reason: '没有可重做的步骤' };
    cursor += 1;
    restore(history[cursor]);
    return { ok: true };
  };

  /* ---- 预选（不进历史，仅用于展示） ---- */
  api.setPending = function (side, action, heroId) {
    if (!pending[side]) pending[side] = {};
    pending[side][action] = heroId;
    return pending[side][action];
  };
  api.getPending = function (side, action) { return pending[side] ? pending[side][action] : undefined; };
  api.clearPending = function () { pending = { blue: {}, red: {} }; };

  /* ---- 序列化 ---- */

  var EXPORT_VERSION = 1;

  api.exportData = function () {
    return {
      app: 'wzbp',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      mode: st.mode,
      step: st.step,
      actions: st.applied.map(function (x) { return { s: x.s, a: x.a, id: x.id }; }),
      bans: { blue: st.bans.blue.slice(), red: st.bans.red.slice() },
      picks: { blue: st.picks.blue.slice(), red: st.picks.red.slice() }
    };
  };

  /* 从导出数据恢复：按顺序重放每一步，保证状态合法。
     校验全部前置——不合法的输入必须「原样返回错误、不动当前 BP」，
     之前是先把状态清空再 import，结果喂个 {} 就把用户正在做的局清掉了。 */
  api.importData = function (data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: '数据格式错误' };
    }
    if (data.app && data.app !== 'wzbp') return { ok: false, reason: '不是本站导出的 BP 文件' };

    var mode = data.mode === undefined || data.mode === null || data.mode === ''
      ? modeByIdStrict(MODES[0].id)            // 没写赛制时按默认赛制处理
      : modeByIdStrict(data.mode);
    if (!mode) return { ok: false, reason: '未知赛制：' + data.mode };

    var acts = Array.isArray(data.actions) ? data.actions : null;
    var byList = !!(data.bans && data.picks &&
      (Array.isArray(data.bans.blue) || Array.isArray(data.picks.blue)));

    if (!acts && !byList) return { ok: false, reason: '文件里没有任何 BP 数据' };
    if (acts && !acts.length) return { ok: false, reason: '文件里没有任何 BP 数据' };

    st = blankState(mode.id);
    recompute();                    // 同上：先补全 pool 再快照
    history = [snapshot()];
    cursor = 0;
    pending = { blue: {}, red: {} };

    var applied = 0, skipped = [];

    if (acts) {
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        if (!a || a.id === undefined || a.id === null) { skipped.push(i); continue; }
        var r = api.apply(a.s, a.a, a.id);
        if (r.ok) applied++;
        else { skipped.push(i); }
        if (st.done) break;
      }
    } else if (byList) {
      /* 兼容只给 bans/picks 的简化数据：按 steps 顺序尽量填 */
      var steps = activeSteps(mode);
      var bi = { blue: 0, red: 0 }, pi = { blue: 0, red: 0 };
      for (var k = 0; k < steps.length; k++) {
        var sp = steps[k];
        var sides = sp.s === 'both' ? ['blue', 'red'] : [sp.s];
        var okAll = true;
        var staged = [];
        for (var m = 0; m < sides.length; m++) {
          var side = sides[m];
          var arr = sp.a === 'ban' ? (data.bans[side] || []) : (data.picks[side] || []);
          var idx = sp.a === 'ban' ? bi[side] : pi[side];
          if (idx >= arr.length) { okAll = false; break; }
          staged.push({ s: side, a: sp.a, id: arr[idx] });
        }
        if (!okAll) break;
        staged.forEach(function (x) {
          if (!st.done && api.apply(x.s, x.a, x.id).ok) applied++;
        });
        if (sp.a === 'ban') { bi.blue += (sp.s === 'both' || sp.s === 'blue') ? 1 : 0; bi.red += (sp.s === 'both' || sp.s === 'red') ? 1 : 0; }
        else { pi.blue += (sp.s === 'both' || sp.s === 'blue') ? 1 : 0; pi.red += (sp.s === 'both' || sp.s === 'red') ? 1 : 0; }
        if (st.done) break;
      }
    }
    emit();
    return { ok: true, applied: applied, skipped: skipped.length, state: snapshotState() };
  };

  /* ---- 分享短码 ---- */
  api.shareCode = function () {
    var d = api.exportData();
    var compact = { v: d.version, m: d.mode, a: d.actions.map(function (x) { return [x.s[0], x.a[0], x.id]; }) };
    return WZ.util.toUrlSafe(WZ.util.b64encode(JSON.stringify(compact)));
  };

  function codeToExport(code) {
    var json = WZ.util.b64decode(WZ.util.fromUrlSafe(code));
    var c = JSON.parse(json);
    if (!c || !Array.isArray(c.a)) return null;
    return {
      app: 'wzbp', version: c.v || 1, mode: c.m, step: c.a.length,
      actions: c.a.map(function (x) { return { s: x[0] === 'b' ? 'blue' : 'red', a: x[1] === 'b' ? 'ban' : 'pick', id: x[2] }; })
    };
  }

  api.applyShareCode = function (code) {
    try {
      var d = codeToExport(String(code).trim());
      if (!d) return { ok: false, reason: '分享码无法解析' };
      return api.importData(d);
    } catch (e) {
      return { ok: false, reason: '分享码无法解析' };
    }
  };

  WZ.draft = api;
})(window.WZ);
