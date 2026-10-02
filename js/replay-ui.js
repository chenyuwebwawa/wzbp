/* ============================================================
   wzbp · 历史对局 + 时间轴回放
   ------------------------------------------------------------
   「保存的 BP 数据可以被展示还原」是这个模块存在的唯一理由，
   所以设计上有三条硬要求：
   1. 只认 order + actions（契约 §4）：不查 WZ.draft 的内置赛制表，
      随机征召的自定义顺序也能原样还原。
   2. 进度条可以拖到任意第 N 手并重建盘面：stateAt(model, N) 是纯函数，
      「跳转」与「从头播到 N」得到的是同一份盘面（自检里逐手比对过）。
   3. 每一步都能说清楚：第几手 / 距上一手多久（gapMs）/ 谁选的（nickname）/
      选了谁（heroId + heroName）/ 蓝方还是红方。
   盘面渲染复用展示板自己的 CSS（board.css 的类都是全局的），
   按 1600×900 设计稿等比缩放进弹窗，因此与 OBS 采集画面同构。
   注意：没有调用 WZ.board.render()——它写死渲染到线上 #board 控件，
   且 findFocus 依赖 WZ.draft 内置赛制表，会把随机征召的中央大图算错。
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var panel = {};

  var initialized = false;
  var styleInjected = false;
  var dom = {};
  var online = false;

  var view = 'list';           // list | replay
  var listScope = 'recent';    // recent | room
  var games = [];
  var listLoading = false;
  var listError = '';

  var model = null;            // 当前回放模型
  var cursor = 0;              // 已落手数：0 = 开局，N = 第 N 手刚落下
  var play = { playing: false, speed: 1, timer: null };

  var SPEEDS = [0.5, 1, 2, 4];
  var MODE_NAME = { ranked: '排位征召', kpl: 'KPL 全局 BP', peak: '巅峰赛', random: '随机征召' };
  var ORD = ['一', '二', '三', '四', '五'];

  /* ============================================================
     一、通用小工具
     ============================================================ */

  function mk(tag, cls, text) {
    if (WZ.util && typeof WZ.util.el === 'function') {
      var n = WZ.util.el(tag, cls, text);
      if (n) return n;
    }
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function setText(el, text) { if (el) el.textContent = text === undefined || text === null ? '' : String(text); }
  function util() { return WZ.util || {}; }

  function describe(err) {
    if (WZ.net && typeof WZ.net.describe === 'function') return WZ.net.describe(err);
    return err && err.message ? String(err.message) : String(err);
  }

  function toast(msg, kind, ms) {
    try {
      if (WZ.app && typeof WZ.app.toast === 'function') { WZ.app.toast(msg, kind, ms); return; }
    } catch (e) { /* 落到兜底 */ }
    try {
      var box = document.getElementById('wzRoomToast');
      if (!box) {
        box = mk('div', 'wz-toast');
        box.id = 'wzRoomToast';
        if (document.body) document.body.appendChild(box);
      }
      box.className = 'wz-toast show ' + (kind || '');
      box.textContent = String(msg);
      clearTimeout(box._t);
      box._t = setTimeout(function () { box.className = 'wz-toast ' + (kind || ''); }, ms || 2200);
    } catch (e) { console.log('[replay] ' + msg); }
  }

  function sideLabel(side, both) {
    if (both || side === 'both') return '双方';
    return side === 'red' ? '红方' : '蓝方';
  }
  function actionLabel(a) { return a === 'pick' ? '选择' : '禁用'; }

  /* 间隔格式化：1200 → 1.2s，45000 → 45s，95000 → 1分35秒 */
  function fmtGap(ms) {
    ms = Math.max(0, Number(ms) || 0);
    if (ms < 1000) return Math.round(ms) + 'ms';
    var s = ms / 1000;
    if (s < 60) return (s < 10 ? (Math.round(s * 10) / 10).toFixed(1) : String(Math.round(s))) + 's';
    var m = Math.floor(s / 60);
    var r = Math.round(s % 60);
    return m + '分' + (r ? r + '秒' : '');
  }

  function fmtDuration(ms) {
    ms = Math.max(0, Number(ms) || 0);
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  function parseTime(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtClock(v) {
    var d = parseTime(v);
    if (!d) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtDateTime(v) {
    var d = parseTime(v);
    if (!d) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ============================================================
     二、数据归一化（服务端字段以契约为准，但尽量容忍 snake_case）
     ============================================================ */

  function normOrder(order) {
    if (!Array.isArray(order)) return [];
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var o = order[i] || {};
      var s = o.s || o.side || o.team || 'blue';
      if (s !== 'red' && s !== 'both') s = 'blue';
      var a = (o.a || o.action) === 'pick' ? 'pick' : 'ban';
      out.push({
        i: i,
        s: s,
        a: a,
        p: o.p || o.phase || (a === 'pick' ? '选择阶段' : '禁用阶段'),
        t: o.t || o.tip || '',
        n: Math.max(1, Number(o.n) || 1)
      });
    }
    return out;
  }

  function num(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    var n = Number(v);
    return isNaN(n) ? v : n;
  }

  function normActions(actions) {
    if (!Array.isArray(actions)) return [];
    var out = actions.map(function (a, i) {
      a = a || {};
      var heroId = num(a.heroId !== undefined && a.heroId !== null ? a.heroId : a.hero_id);
      var hi = a.stepIndex !== undefined && a.stepIndex !== null ? a.stepIndex : a.step_index;
      return {
        seq: Number(a.seq) || (i + 1),
        stepIndex: hi === undefined || hi === null ? i : Number(hi),
        side: a.side === 'red' ? 'red' : 'blue',
        action: a.action === 'pick' ? 'pick' : 'ban',
        heroId: heroId,
        heroName: a.heroName || a.hero_name || '',
        nickname: a.nickname || a.playerName || a.player_name || '',
        playerKey: a.playerKey || a.player_key || '',
        actedAt: a.actedAt || a.acted_at || '',
        gapMs: Math.max(0, Number(a.gapMs !== undefined && a.gapMs !== null ? a.gapMs : a.gap_ms) || 0)
      };
    });
    out.sort(function (x, y) { return x.seq - y.seq; });
    return out;
  }

  /* 英雄对象：数据里有就用数据里的（有原画/皮肤），没有就用 id+名字兜底 */
  function heroOf(a) {
    if (!a) return null;
    var h = util().heroById ? util().heroById(a.heroId) : null;
    if (h) return h;
    if (a.heroId === undefined || a.heroId === null || a.heroId === '') return null;
    return { id: a.heroId, name: a.heroName || ('#' + a.heroId), synthetic: true };
  }

  function heroNameOf(a) {
    var h = util().heroById ? util().heroById(a.heroId) : null;
    return (h && h.name) || a.heroName || (a.heroId !== undefined && a.heroId !== null ? '#' + a.heroId : '未知');
  }

  /* 从对局对象里尽力掏阵容：契约没规定列表项形状，这里多路兜底 */
  function picksFromActions(acts) {
    var out = { blue: [], red: [] };
    (acts || []).forEach(function (a) {
      var act = a || {};
      if ((act.action || act.a) !== 'pick') return;
      var side = (act.side || act.s) === 'red' ? 'red' : 'blue';
      var id = num(act.heroId !== undefined && act.heroId !== null ? act.heroId : act.hero_id);
      if (id !== null) out[side].push(id);
    });
    return out;
  }

  function picksOf(g) {
    if (!g) return null;
    var p = g.picks;
    if (p && (Array.isArray(p.blue) || Array.isArray(p.red))) {
      return { blue: p.blue || [], red: p.red || [] };
    }
    if (Array.isArray(g.bluePicks) || Array.isArray(g.redPicks)) {
      return { blue: g.bluePicks || [], red: g.redPicks || [] };
    }
    if (Array.isArray(g.actions)) return picksFromActions(g.actions);
    return null;
  }

  function normGame(g) {
    if (!g || typeof g !== 'object') return null;
    var id = g.id !== undefined && g.id !== null ? g.id
      : (g.gameId !== undefined && g.gameId !== null ? g.gameId : g.game_id);
    return {
      raw: g,
      id: id,
      code: String(g.code || g.roomCode || g.room_code || (g.room && g.room.code) || '').toUpperCase(),
      roomName: g.roomName || g.room_name || (g.room && g.room.name) || '',
      gameNo: Number(g.gameNo !== undefined && g.gameNo !== null ? g.gameNo : (g.game_no || 1)) || 1,
      mode: g.mode || (g.room && g.room.mode) || '',
      winner: g.winner || null,
      status: g.status || '',
      startedAt: g.startedAt || g.started_at || '',
      finishedAt: g.finishedAt || g.finished_at || '',
      /* actionCount 由后端在列表里直接给（没开打的局是 0）；没有 actions 数组时也用它 */
      actionsCount: Array.isArray(g.actions) ? g.actions.length
        : (Number(g.actionCount || g.actionsCount || g.action_count) || 0),
      picks: picksOf(g)
    };
  }

  /* ============================================================
     三、回放模型：order + actions → 任意游标的盘面
     ============================================================ */

  function buildModel(payload) {
    payload = payload || {};
    var game = payload.game || {};
    var actions = normActions(payload.actions);
    var order = normOrder(payload.order);
    if (!order.length) order = normOrder(game.order);
    if (!order.length) order = normOrder(game.series && game.series.order);

    var mode = game.mode || (game.room && game.room.mode) || (payload.room && payload.room.mode) || 'ranked';

    var m = {
      game: game,
      actions: actions,
      order: order,
      mode: mode,
      modeName: MODE_NAME[mode] || (WZ.draft && WZ.draft.modeById ? WZ.draft.modeById(mode).name : mode),
      cap: { blue: { ban: 0, pick: 5 }, red: { ban: 0, pick: 5 } },
      stepSides: []
    };

    /* 每侧 ban 位容量：按蓝图累加（KPL 是 3+2=5，巅峰赛是一个 both 步各 3） */
    order.forEach(function (o) {
      if (o.a !== 'ban') return;
      if (o.s === 'both') { m.cap.blue.ban += o.n; m.cap.red.ban += o.n; }
      else m.cap[o.s].ban += o.n;
    });

    /* stepSides：仅作展示提示（'both' 步骤取先出手的一方），与 draft.js 语义对齐 */
    if (order.length) {
      var k = 0;
      order.forEach(function (o) {
        var need = (o.s === 'both' ? 2 : 1) * o.n;
        var first = null;
        for (var j = 0; j < need; j++) {
          var a = actions[k];
          if (!first && a && a.side) first = a.side;
          k++;
        }
        m.stepSides.push(o.s === 'both' ? (first || 'blue') : o.s);
      });
    }
    return m;
  }

  function clampK(m, k) {
    k = Number(k);
    if (isNaN(k)) k = 0;
    return Math.max(0, Math.min(Math.round(k), m.actions.length));
  }

  /* 游标 k 落在蓝图的第几步、这一步还有谁没出手 */
  function stepStateAt(m, k) {
    var order = m.order, acts = m.actions;
    if (!order.length) {
      /* 没有蓝图（老数据）时退化成「一手一步」，阶段名按动作自身推断 */
      var next = acts[k];
      return {
        index: Math.min(k, Math.max(acts.length, 1)),
        total: Math.max(acts.length, 1),
        done: k >= acts.length,
        info: next ? {
          side: next.side, action: next.action,
          phase: next.action === 'ban' ? '禁用阶段' : '选择阶段', tip: ''
        } : null,
        stepDone: []
      };
    }

    var remaining = k, idx = 0;
    while (idx < order.length) {
      var o = order[idx];
      var need = (o.s === 'both' ? 2 : 1) * o.n;
      if (remaining >= need) { remaining -= need; idx++; continue; }

      /* 当前就在这一步：remaining 表示本步已落的手数 */
      var counts = { blue: 0, red: 0 };
      for (var j = k - remaining; j < k; j++) {
        var a = acts[j];
        if (a && (a.side === 'blue' || a.side === 'red')) counts[a.side]++;
      }
      var doneSides = [];
      (o.s === 'both' ? ['blue', 'red'] : [o.s]).forEach(function (side) {
        if ((counts[side] || 0) >= o.n) doneSides.push(side);
      });
      return {
        index: idx, total: order.length, done: false,
        info: { side: o.s, action: o.a, phase: o.p, tip: o.t },
        stepDone: doneSides
      };
    }
    return { index: order.length, total: order.length, done: true, info: null, stepDone: [] };
  }

  function takenMap(bans, picks) {
    var t = {};
    ['blue', 'red'].forEach(function (side) {
      (bans[side] || []).concat(picks[side] || []).forEach(function (id) { t[String(id)] = 1; });
    });
    return t;
  }

  function poolOf(bans, picks) {
    var all = WZ.HEROES || [];
    if (!all.length) return [];
    var taken = takenMap(bans, picks);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!taken[String(all[i].id)]) out.push(all[i].id);
    }
    return out;
  }

  /**
   * 游标 k 处的完整盘面（纯函数，与展示板 state 形状同构）。
   * 关键：整体重建而不是「增量回滚」，所以任意跳转与顺序播放结果一致。
   */
  function stateAt(m, k) {
    k = clampK(m, k);
    var bans = { blue: [], red: [] };
    var picks = { blue: [], red: [] };
    for (var i = 0; i < k; i++) {
      var a = m.actions[i];
      if (!a) continue;
      (a.action === 'ban' ? bans : picks)[a.side].push(a.heroId);
    }
    var ss = stepStateAt(m, k);
    return {
      mode: m.mode,
      modeName: m.modeName,
      step: ss.index,
      totalSteps: ss.total,
      stepInfo: ss.info,
      stepDone: ss.stepDone,
      stepSides: m.stepSides,
      bans: bans,
      picks: picks,
      pool: poolOf(bans, picks),
      done: ss.done || k >= m.actions.length,
      cap: m.cap,
      cursor: k,
      /* 回放专属字段（展示板不需要，但详情面板/接线要用） */
      action: k > 0 ? m.actions[k - 1] : null,
      totalActions: m.actions.length
    };
  }

  /* 中央大图该展示哪一手：游标处刚落下的那一手 */
  function focusAt(m, k) {
    if (k <= 0) return null;
    var a = m.actions[k - 1];
    if (!a) return null;
    var hero = heroOf(a);
    if (!hero) return null;
    var label;
    if (a.action === 'ban') label = sideLabel(a.side) + '禁用';
    else {
      var n = 0;
      for (var i = 0; i <= k - 1; i++) {
        if (m.actions[i] && m.actions[i].action === 'pick' && m.actions[i].side === a.side) n++;
      }
      label = sideLabel(a.side) + ' ' + (ORD[n - 1] || n) + '楼';
    }
    return { hero: hero, label: label, side: a.side, action: a };
  }

  /* ============================================================
     四、样式（注入，不改 CSS 文件）
     ============================================================ */

  var CSS = [
    '.wz-rp-backdrop { position: fixed; inset: 0; z-index: 120; background: rgba(4,7,12,.8);',
    '  display: grid; place-items: center; padding: 16px; }',
    '.wz-rp-modal { width: min(1500px, 97vw); height: min(940px, 94vh); display: flex; flex-direction: column;',
    '  background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); overflow: hidden; }',
    '.wz-rp-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); flex: 0 0 auto; }',
    '.wz-rp-title { font-size: 15px; font-weight: 700; }',
    '.wz-rp-sub { flex: 1 1 auto; min-width: 0; color: var(--text-faint); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.wz-rp-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px 14px 20px; }',
    '.wz-rp-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }',
    '.wz-rp-tabs button { appearance: none; font-family: inherit; font-size: 12.5px; padding: 7px 12px; border-radius: 8px;',
    '  border: 1px solid var(--line); background: var(--panel-2); color: var(--text-dim); cursor: pointer; }',
    '.wz-rp-tabs button.on { background: rgba(58,160,255,.16); border-color: var(--blue); color: #cfe6ff; }',
    '.wz-rp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 10px; }',
    '.wz-rp-card { text-align: left; color: var(--text); font-family: inherit; cursor: pointer; padding: 10px 12px;',
    '  border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }',
    '.wz-rp-card:hover { border-color: var(--blue); background: var(--panel-3); }',
    '.wz-rp-card-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }',
    '.wz-rp-card-head .code { font-family: var(--font-num); letter-spacing: 2px; color: #a9bcd8; margin-left: auto; }',
    '.wz-rp-card-meta { margin-top: 3px; font-size: 11.5px; color: var(--text-faint); }',
    '.wz-rp-lineup { display: grid; grid-template-columns: 1fr auto 1fr; gap: 6px; align-items: center; margin-top: 8px; }',
    '.wz-rp-lineup-hint { margin-top: 8px; font-size: 11.5px; color: var(--text-faint); }',
    '.wz-rp-line { display: flex; gap: 3px; }',
    '.wz-rp-line.red { justify-content: flex-end; }',
    '.wz-rp-av { width: 34px; height: 34px; border-radius: 7px; object-fit: cover; background: linear-gradient(160deg,#223047,#131b29); }',
    '.wz-rp-av.empty { opacity: .35; }',
    '.wz-rp-vs { font-family: var(--font-num); color: var(--text-faint); font-size: 12px; }',
    '.wz-rp-win { padding: 0 7px; border-radius: 8px; font-size: 11.5px; }',
    '.wz-rp-win.blue { background: rgba(58,160,255,.18); color: #a9d6ff; }',
    '.wz-rp-win.red { background: rgba(255,77,94,.18); color: #ffc3ca; }',
    '.wz-rp-win.none { background: rgba(147,164,192,.14); color: var(--text-dim); }',
    '.wz-rp-replay { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0,1fr) 340px;',
    '  grid-template-rows: minmax(0,1fr) auto; }',
    '.wz-rp-stage { grid-column: 1; grid-row: 1; display: grid; place-items: center; overflow: hidden; padding: 10px;',
    '  background: radial-gradient(80% 80% at 50% 0%, rgba(58,160,255,.08), transparent 65%); }',
    '.wz-rp-side { grid-column: 2; grid-row: 1; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--line); }',
    '.wz-rp-detail { padding: 12px 14px; border-bottom: 1px solid var(--line-soft); flex: 0 0 auto; }',
    '.wz-rp-step-title { font-size: 13px; color: var(--text-dim); font-family: var(--font-num); letter-spacing: 1px; }',
    '.wz-rp-step-hero { margin: 4px 0 6px; font-size: 26px; font-weight: 800; letter-spacing: 2px; }',
    '.wz-rp-step-meta { font-size: 12.5px; color: var(--text-faint); line-height: 1.7; }',
    '.wz-rp-steps { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 8px 10px; }',
    '.wz-rp-step { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer;',
    '  font-size: 12.5px; color: var(--text-dim); border: 1px solid transparent; }',
    '.wz-rp-step:hover { background: var(--panel-2); }',
    '.wz-rp-step.on { background: rgba(255,201,102,.12); border-color: rgba(255,201,102,.45); color: var(--text); }',
    '.wz-rp-step .no { font-family: var(--font-num); width: 22px; flex: 0 0 auto; color: var(--text-faint); }',
    '.wz-rp-step .nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.wz-rp-step .tag { flex: 0 0 auto; font-size: 11px; padding: 0 6px; border-radius: 7px; border: 1px solid #23314a; }',
    '.wz-rp-step .tag.blue { color: #a9d6ff; border-color: rgba(58,160,255,.4); }',
    '.wz-rp-step .tag.red { color: #ffc3ca; border-color: rgba(255,77,94,.4); }',
    '.wz-rp-step .gp { flex: 0 0 auto; color: var(--text-faint); font-size: 11.5px; }',
    '.wz-rp-timeline { grid-column: 1 / -1; grid-row: 2; border-top: 1px solid var(--line); padding: 9px 14px 12px; }',
    '.wz-rp-controls { display: flex; align-items: center; gap: 8px; }',
    '.wz-rp-controls button { appearance: none; font-family: inherit; min-width: 38px; padding: 6px 9px; border-radius: 8px;',
    '  border: 1px solid var(--line); background: var(--panel-2); color: var(--text); cursor: pointer; font-size: 13px; }',
    '.wz-rp-controls button:hover { border-color: #35486a; background: var(--panel-3); }',
    '.wz-rp-controls button.primary { background: rgba(58,160,255,.18); border-color: var(--blue); color: #cfe6ff; min-width: 88px; }',
    '.wz-rp-controls input[type=range] { flex: 1 1 auto; min-width: 120px; accent-color: var(--blue); height: 22px; cursor: pointer; }',
    '.wz-rp-count { font-family: var(--font-num); color: #a9bcd8; letter-spacing: 1px; min-width: 62px; text-align: right; }',
    '.wz-rp-controls2 { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 12.5px; color: var(--text-faint); }',
    '.wz-rp-controls2 .sp { padding: 3px 9px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2);',
    '  color: var(--text-dim); cursor: pointer; font-family: inherit; font-size: 12px; }',
    '.wz-rp-controls2 .sp.on { background: rgba(58,160,255,.16); border-color: var(--blue); color: #cfe6ff; }',
    '.wz-rp-controls2 .tm { margin-left: auto; font-family: var(--font-num); }',
    '.wz-board-fit { position: relative; width: calc(1600px * var(--board-scale, 1)); height: calc(900px * var(--board-scale, 1)); }',
    '.wz-replay-board { box-shadow: 0 18px 50px rgba(0,0,0,.55); }',
    '.wz-rp-empty { padding: 26px 10px; text-align: center; color: var(--text-faint); font-size: 13px; line-height: 1.9; }'
  ].join('\n');

  function injectStyle() {
    if (styleInjected || document.getElementById('wz-replay-style')) { styleInjected = true; return; }
    var s = document.createElement('style');
    s.id = 'wz-replay-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
    styleInjected = true;
  }

  /* ============================================================
     五、弹窗与盘面骨架
     ============================================================ */

  function buildEntry() {
    var btn = mk('button', 'btn btn-ghost', '战绩');
    btn.type = 'button';
    btn.id = 'btnReplayPanel';
    btn.title = '历史对局与时间轴回放（可拖动进度条跳到任意一手）';
    btn.addEventListener('click', function () { panel.open(); });

    var host = document.querySelector('.appbar-right');
    var ref = document.getElementById('btnRoomPanel') || document.getElementById('btnStoryPanel');
    if (host && ref && ref.parentNode === host) host.insertBefore(btn, ref.nextSibling);
    else if (host) host.appendChild(btn);
    else {
      btn.className = 'btn btn-ghost wz-float-entry';
      if (document.body) document.body.appendChild(btn);
    }
    return btn;
  }

  function banSlot() {
    var slot = mk('div', 'ban-slot was-empty');
    slot.appendChild(mk('div', 'bs-empty', 'BAN'));
    slot.appendChild(mk('div', 'bs-cross'));
    slot.appendChild(mk('div', 'bs-name'));
    slot.style.display = 'none';
    return slot;
  }

  function pickSlot(side, index) {
    var slot = mk('div', 'pick-slot empty-' + side);
    var art = mk('div', 'ps-art');
    var veil = mk('div', 'ps-veil');
    var body = mk('div', 'ps-body');
    body.appendChild(mk('div', 'ps-name'));
    body.appendChild(mk('div', 'ps-sub'));
    var empty = mk('div', 'ps-empty', (side === 'blue' ? '蓝方' : '红方') + '第 ' + (index + 1) + ' 位');
    slot.appendChild(art); slot.appendChild(veil); slot.appendChild(body); slot.appendChild(empty);
    return slot;
  }

  var MAX_BANS = 5;    // 与 board.js 一致：KPL 单侧最多 5 个 ban 位

  function buildBoard() {
    var fit = mk('div', 'wz-board-fit');
    var b = mk('div', 'board wz-replay-board');
    b.id = 'wzReplayBoard';                 // 便于接线/自检定位这块只读盘面
    b.appendChild(mk('div', 'board-scanline'));

    var head = mk('header', 'board-head');
    var laneBlue = mk('div', 'ban-lane ban-lane-blue');
    var laneRed = mk('div', 'ban-lane ban-lane-red');
    var title = mk('div', 'board-title');
    title.appendChild(mk('div', 'board-kicker', 'HONOR OF KINGS · DRAFT PICK'));
    var modeEl = mk('h1', 'board-mode', '回放');
    title.appendChild(modeEl);
    var phaseWrap = mk('div', 'board-phase');
    var dot = mk('span', 'phase-dot');
    var phaseText = mk('span', '', '回放');
    phaseWrap.appendChild(dot);
    phaseWrap.appendChild(phaseText);
    title.appendChild(phaseWrap);
    head.appendChild(laneBlue);
    head.appendChild(title);
    head.appendChild(laneRed);

    var body = mk('main', 'board-body');
    var colBlue = mk('div', 'team-col team-blue');
    colBlue.setAttribute('data-label', '蓝方阵容');
    var colRed = mk('div', 'team-col team-red');
    colRed.setAttribute('data-label', '红方阵容');

    var stage = mk('div', 'hero-stage');
    var badge = mk('div', 'badge badge-slot', '回放');
    var splash = mk('img', 'splash');
    splash.alt = '';
    var fallback = mk('div', 'splash-fallback', '王');
    var nameBar = mk('div', 'hero-name-bar');
    var heroName = mk('div', 'hero-name', '—');
    var heroTitle = mk('div', 'hero-title', '');
    nameBar.appendChild(heroName);
    nameBar.appendChild(heroTitle);
    stage.appendChild(badge);
    stage.appendChild(splash);
    stage.appendChild(fallback);
    stage.appendChild(nameBar);

    body.appendChild(colBlue);
    body.appendChild(stage);
    body.appendChild(colRed);

    var status = mk('div', 'board-status');
    var stLeft = mk('div', 'st-left');
    var stRight = mk('div', 'st-right');
    status.appendChild(stLeft);
    status.appendChild(stRight);

    b.appendChild(head);
    b.appendChild(body);
    b.appendChild(status);
    fit.appendChild(b);

    var banSlots = { blue: [], red: [] };
    var pickSlots = { blue: [], red: [] };
    ['blue', 'red'].forEach(function (side) {
      var lane = side === 'blue' ? laneBlue : laneRed;
      for (var i = 0; i < MAX_BANS; i++) {
        var s = banSlot();
        lane.appendChild(s);
        banSlots[side].push(s);
      }
      var col = side === 'blue' ? colBlue : colRed;
      for (var j = 0; j < 5; j++) {
        var p = pickSlot(side, j);
        col.appendChild(p);
        pickSlots[side].push(p);
      }
    });

    return {
      fit: fit, board: b, modeEl: modeEl, phaseText: phaseText, phaseDot: dot,
      banSlots: banSlots, pickSlots: pickSlots, stage: stage, splash: splash,
      badge: badge, heroName: heroName, heroTitle: heroTitle,
      stLeft: stLeft, stRight: stRight
    };
  }

  function buildModal() {
    var wrap = mk('div', 'wz-rp-backdrop');
    wrap.id = 'wzRpModal';
    wrap.hidden = true;

    var modal = mk('div', 'wz-rp-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '历史对局与回放');

    var head = mk('header', 'wz-rp-head');
    var title = mk('span', 'wz-rp-title', '历史对局');
    title.id = 'wzRpTitle';
    var sub = mk('span', 'wz-rp-sub', '');
    sub.id = 'wzRpSub';
    var back = mk('button', 'btn btn-ghost', '← 返回列表');
    back.type = 'button';
    back.id = 'wzRpBack';
    back.hidden = true;
    var close = mk('button', 'btn btn-ghost', '关闭');
    close.type = 'button';
    close.id = 'wzRpClose';
    head.appendChild(title); head.appendChild(sub); head.appendChild(back); head.appendChild(close);

    /* 列表视图 */
    var listView = mk('div', 'wz-rp-list');
    listView.id = 'wzRpListView';
    var tabs = mk('div', 'wz-rp-tabs');
    var tabRecent = mk('button', 'on', '最近对局（跨房间）');
    tabRecent.type = 'button';
    tabRecent.dataset.scope = 'recent';
    var tabRoom = mk('button', '', '本房间战绩');
    tabRoom.type = 'button';
    tabRoom.dataset.scope = 'room';
    var reload = mk('button', '', '刷新');
    reload.type = 'button';
    reload.dataset.reload = '1';
    tabs.appendChild(tabRecent); tabs.appendChild(tabRoom); tabs.appendChild(reload);
    var cards = mk('div', 'wz-rp-cards');
    cards.id = 'wzRpCards';
    listView.appendChild(tabs);
    listView.appendChild(cards);

    /* 回放视图 */
    var replayView = mk('div', 'wz-rp-replay');
    replayView.id = 'wzRpReplayView';
    replayView.hidden = true;
    var stage = mk('div', 'wz-rp-stage');
    stage.id = 'wzRpStage';
    var board = buildBoard();
    stage.appendChild(board.fit);

    var side = mk('aside', 'wz-rp-side');
    var detail = mk('div', 'wz-rp-detail');
    var stepTitle = mk('div', 'wz-rp-step-title', '开局');
    stepTitle.id = 'wzRpStepTitle';
    var stepHero = mk('div', 'wz-rp-step-hero', '—');
    stepHero.id = 'wzRpStepHero';
    var stepMeta = mk('div', 'wz-rp-step-meta', '');
    stepMeta.id = 'wzRpStepMeta';
    detail.appendChild(stepTitle); detail.appendChild(stepHero); detail.appendChild(stepMeta);
    var steps = mk('div', 'wz-rp-steps');
    steps.id = 'wzRpSteps';
    side.appendChild(detail);
    side.appendChild(steps);

    var timeline = mk('div', 'wz-rp-timeline');
    var c1 = mk('div', 'wz-rp-controls');
    var bFirst = mk('button', '', '⏮');
    bFirst.type = 'button'; bFirst.title = '回到开局';
    var bPrev = mk('button', '', '◀');
    bPrev.type = 'button'; bPrev.title = '上一步（←）';
    var bPlay = mk('button', 'primary', '▶ 播放');
    bPlay.type = 'button'; bPlay.title = '播放 / 暂停（空格）';
    var bNext = mk('button', '', '▶');
    bNext.type = 'button'; bNext.title = '下一步（→）';
    var bLast = mk('button', '', '⏭');
    bLast.type = 'button'; bLast.title = '跳到最后一手';
    var range = mk('input', '');
    range.type = 'range';
    range.min = '0'; range.max = '0'; range.step = '1'; range.value = '0';
    range.id = 'wzRpRange';
    var count = mk('span', 'wz-rp-count', '0 / 0');
    count.id = 'wzRpCount';
    c1.appendChild(bFirst); c1.appendChild(bPrev); c1.appendChild(bPlay);
    c1.appendChild(bNext); c1.appendChild(bLast); c1.appendChild(range); c1.appendChild(count);

    var c2 = mk('div', 'wz-rp-controls2');
    c2.appendChild(mk('span', '', '速度'));
    var speeds = mk('span', '');
    speeds.id = 'wzRpSpeeds';
    SPEEDS.forEach(function (sp) {
      var b = mk('button', 'sp' + (sp === 1 ? ' on' : ''), sp + 'x');
      b.type = 'button';
      b.dataset.speed = String(sp);
      b.addEventListener('click', function () { panel.setSpeed(sp); });
      speeds.appendChild(b);
    });
    c2.appendChild(speeds);
    var timeEl = mk('span', 'tm', '');
    timeEl.id = 'wzRpTime';
    c2.appendChild(timeEl);
    timeline.appendChild(c1);
    timeline.appendChild(c2);

    replayView.appendChild(stage);
    replayView.appendChild(side);
    replayView.appendChild(timeline);

    modal.appendChild(head);
    modal.appendChild(listView);
    modal.appendChild(replayView);
    wrap.appendChild(modal);

    close.addEventListener('click', function () { panel.close(); });
    back.addEventListener('click', function () { setView('list'); });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) panel.close(); });
    tabs.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.reload) { loadList(listScope); return; }
      if (t.dataset.scope) { loadList(t.dataset.scope); }
    });
    bFirst.addEventListener('click', function () { stopPlay(); goto(0); });
    bPrev.addEventListener('click', function () { stopPlay(); goto(cursor - 1); });
    bNext.addEventListener('click', function () { stopPlay(); goto(cursor + 1); });
    bLast.addEventListener('click', function () { stopPlay(); goto(model ? model.actions.length : 0); });
    bPlay.addEventListener('click', function () { togglePlay(); });
    range.addEventListener('input', function () {
      /* 拖动进度条 = 任意跳转，必须立刻重建盘面 */
      goto(Number(range.value), true);
    });

    dom = {
      wrap: wrap, modal: modal, title: title, sub: sub, back: back,
      listView: listView, replayView: replayView, cards: cards, tabs: tabs,
      tabRecent: tabRecent, tabRoom: tabRoom,
      board: board, stage: stage, steps: steps,
      stepTitle: stepTitle, stepHero: stepHero, stepMeta: stepMeta,
      bPlay: bPlay, range: range, count: count, speeds: speeds, timeEl: timeEl
    };
    return wrap;
  }

  /* ============================================================
     六、盘面渲染
     ============================================================ */

  function fillBanSlot(slot, heroId) {
    var hero = heroId === undefined || heroId === null ? null : util().heroById(heroId);
    var img = slot.querySelector('img');
    var nameEl = slot.querySelector('.bs-name');
    slot.style.display = '';
    slot.classList.toggle('was-empty', !hero);
    slot.classList.toggle('filled', !!hero);
    if (hero) {
      if (!img) {
        img = document.createElement('img');
        img.alt = hero.name;
        img.decoding = 'async';
        if (util().bindImgFallback) util().bindImgFallback(img, hero.name);
        slot.insertBefore(img, slot.firstChild);
      }
      if (util().avatarUrl) img.src = util().avatarUrl(hero);
      img.alt = hero.name;
      setText(nameEl, hero.name);
    } else {
      if (img) img.parentNode.removeChild(img);
      setText(nameEl, '');
    }
  }

  function fillPickSlot(slot, heroId, index, side) {
    var hero = heroId === undefined || heroId === null ? null : util().heroById(heroId);
    var art = slot.querySelector('.ps-art');
    var nameEl = slot.querySelector('.ps-name');
    var subEl = slot.querySelector('.ps-sub');
    var emptyEl = slot.querySelector('.ps-empty');
    slot.classList.toggle('filled', !!hero);
    if (hero) {
      art.style.backgroundImage = 'url("' + (util().splashUrl ? util().splashUrl(hero, 0) : '') + '")';
      setText(nameEl, hero.name);
      subEl.innerHTML = '';
      var bits = (hero.roles || []).concat(hero.types || []);
      if (bits.length) {
        bits.forEach(function (t, i) {
          if (i) subEl.appendChild(mk('span', 'sep', '·'));
          subEl.appendChild(document.createTextNode(t));
        });
      } else if (hero.title) {
        setText(subEl, hero.title);
      }
    } else {
      art.style.backgroundImage = '';
      setText(nameEl, '');
      setText(subEl, '');
      setText(emptyEl, (side === 'blue' ? '蓝方' : '红方') + '第 ' + (index + 1) + ' 位');
    }
  }

  function showStageHero(focus) {
    var b = dom.board;
    if (!b) return;
    b.stage.classList.remove('no-art');
    if (!focus || !focus.hero) {
      b.splash.classList.remove('show');
      b.splash.removeAttribute('src');
      setText(b.heroName, '—');
      setText(b.heroTitle, '');
      b.badge.className = 'badge badge-slot';
      setText(b.badge, '未开始');
      return;
    }
    var url = util().splashUrl ? util().splashUrl(focus.hero, 0) : '';
    setText(b.heroName, focus.hero.name || '');
    setText(b.heroTitle, focus.hero.title || '');
    b.badge.className = 'badge badge-slot ' + (focus.side || '');
    setText(b.badge, focus.label || '回放');
    if (!url) {
      b.stage.classList.add('no-art');
      b.splash.classList.remove('show');
      return;
    }
    if (b.splash.getAttribute('src') !== url) {
      b.stage.classList.add('no-art');           // 先当没有原画，加载成功再淡入
      b.splash.classList.remove('show');
      b.splash.onload = function () {
        b.stage.classList.remove('no-art');
        b.splash.classList.add('show');
      };
      b.splash.onerror = function () {
        b.stage.classList.add('no-art');
        b.splash.classList.remove('show');
      };
      b.splash.src = url;
    } else if (b.splash.complete && b.splash.naturalWidth) {
      b.splash.classList.add('show');
      b.stage.classList.remove('no-art');
    }
  }

  function renderBoard(state, focus) {
    var b = dom.board;
    if (!b || !state) return;
    setText(b.modeEl, state.modeName || '回放');

    var info = state.stepInfo;
    var phaseText = '回放结束';
    var dotClass = '';
    if (state.cursor === 0 && state.totalActions > 0) {
      phaseText = '开局 · 等待第一手';
    } else if (info && !state.done) {
      var who = sideLabel(info.side, info.side === 'both');
      phaseText = info.phase + ' · ' + who + actionLabel(info.action);
      if (info.tip) phaseText += ' · ' + info.tip;
      dotClass = info.side === 'both' ? 'gold' : info.side;
    } else {
      phaseText = '本局 BP 结束（回放）';
      dotClass = 'gold';
    }
    setText(b.phaseText, phaseText);
    b.phaseDot.className = 'phase-dot ' + dotClass;
    b.board.classList.toggle('is-done', !!state.done);

    var cap = state.cap || { blue: { ban: 3 }, red: { ban: 3 } };
    ['blue', 'red'].forEach(function (side) {
      var shown = Math.max((cap[side] && cap[side].ban) || 0, 3);
      var lane = b.banSlots[side];
      for (var i = 0; i < lane.length; i++) {
        if (i >= shown) { lane[i].style.display = 'none'; continue; }
        lane[i].style.display = '';
        fillBanSlot(lane[i], state.bans[side][i]);
        lane[i].classList.remove('active');
      }
      for (var j = 0; j < 5; j++) {
        fillPickSlot(b.pickSlots[side][j], state.picks[side][j], j, side);
        b.pickSlots[side][j].classList.remove('active');
      }
    });

    showStageHero(focus);

    /* 底部状态条：与展示板同构 */
    b.stLeft.innerHTML = '';
    b.stRight.innerHTML = '';
    var stepText;
    if (state.cursor === 0) stepText = '回放 · 第 0 / ' + state.totalActions + ' 手';
    else if (state.done) stepText = '回放 · 全部 ' + state.totalActions + ' 手（第 ' + state.cursor + ' 手）';
    else stepText = '回放 · 第 ' + state.cursor + ' / ' + state.totalActions + ' 手';
    b.stLeft.appendChild(mk('span', 'st-step', stepText));
    if (info && !state.done) {
      b.stLeft.appendChild(mk('span', 'st-tag ' + (info.side === 'red' ? 'red' : 'blue'),
        info.side === 'both' ? '双方同时进行' : (info.side === 'blue' ? '蓝方回合' : '红方回合')));
    }
    if (state.pool && state.pool.length) {
      b.stLeft.appendChild(mk('span', '', '未使用英雄 ' + state.pool.length + ' 位'));
    }
    b.stRight.appendChild(mk('span', 'st-tag blue',
      '蓝 · ban ' + state.bans.blue.length + ' / pick ' + state.picks.blue.length));
    b.stRight.appendChild(mk('span', 'st-tag red',
      '红 · ban ' + state.bans.red.length + ' / pick ' + state.picks.red.length));
    var totalMs = 0;
    if (model) model.actions.forEach(function (a) { totalMs += a.gapMs; });
    b.stRight.appendChild(mk('span', '', '总时长 ' + fmtDuration(totalMs)));
  }

  function fitBoard() {
    if (!dom.board || !dom.stage) return;
    var w = Math.max(320, (dom.stage.clientWidth || 900) - 20);
    var h = Math.max(240, (dom.stage.clientHeight || 520) - 20);
    var scale = Math.min(w / 1600, h / 900);
    scale = Math.max(0.25, Math.min(scale, 1));
    dom.board.fit.style.setProperty('--board-scale', String(scale));
  }

  /* ============================================================
     七、时间轴 / 详情 / 手数列表
     ============================================================ */

  function delayFor(i) {
    var a = model.actions[i];
    var g = a && a.gapMs > 0 ? a.gapMs : 1000;
    /* 按真实时间间隔播放（这就是「还原时间」）；下限 150ms 保证看得清，
       上限 20s 避免中场休息把回放卡成静止画面，需要更快就用 2x/4x */
    g = Math.max(150, Math.min(g, 20000));
    return Math.max(16, Math.round(g / play.speed));
  }

  function schedule() {
    if (play.timer) { clearTimeout(play.timer); play.timer = null; }
    if (!play.playing || !model) return;
    if (cursor >= model.actions.length) { setPlaying(false); return; }
    play.timer = setTimeout(function () {
      play.timer = null;
      if (!play.playing || !model) return;
      goto(cursor + 1);
      schedule();
    }, delayFor(cursor));
  }

  function setPlaying(on) {
    play.playing = !!on;
    if (dom.bPlay) setText(dom.bPlay, play.playing ? '⏸ 暂停' : '▶ 播放');
    if (!play.playing && play.timer) { clearTimeout(play.timer); play.timer = null; }
  }

  function togglePlay() {
    if (!model || !model.actions.length) return;
    if (play.playing) { setPlaying(false); return; }
    if (cursor >= model.actions.length) goto(0);     // 播完了再点 → 从头来
    else goto(cursor);                               // 同步一次，保证调度基准正确
    setPlaying(true);
    schedule();
  }

  function stopPlay() { if (play.playing) setPlaying(false); else if (play.timer) { clearTimeout(play.timer); play.timer = null; } }

  function renderDetail() {
    if (!model) return;
    var a = cursor > 0 ? model.actions[cursor - 1] : null;
    if (!a) {
      setText(dom.stepTitle, '开局 · 还没有落任何一手（共 ' + model.actions.length + ' 手）');
      setText(dom.stepHero, '—');
      setText(dom.stepMeta, model.actions.length
        ? '点「播放」或拖动进度条，逐步还原这一局的 BP 过程'
        : '这局没有任何 BP 记录');
      return;
    }
    setText(dom.stepTitle, '第 ' + a.seq + ' 手 / 共 ' + model.actions.length + ' 手 · ' +
      sideLabel(a.side) + actionLabel(a.action));
    setText(dom.stepHero, heroNameOf(a));
    var bits = ['距上一手 ' + fmtGap(a.gapMs)];
    bits.push('选择人 ' + (a.nickname || '未记录'));
    var clock = fmtClock(a.actedAt);
    if (clock) bits.push(clock);
    setText(dom.stepMeta, bits.join(' · '));
  }

  function cumulativeMs(k) {
    var sum = 0;
    if (!model) return 0;
    for (var i = 0; i < k && i < model.actions.length; i++) sum += model.actions[i].gapMs;
    return sum;
  }

  function renderTimeline() {
    if (!model) return;
    var max = model.actions.length;
    if (dom.range) {
      dom.range.max = String(max);
      dom.range.value = String(cursor);
    }
    setText(dom.count, cursor + ' / ' + max);
    var total = cumulativeMs(max);
    setText(dom.timeEl, '已过 ' + fmtDuration(cumulativeMs(cursor)) + ' / 总 ' + fmtDuration(total) +
      ' · 当前 ' + (play.playing ? '播放中' : '已暂停') + ' · ' + play.speed + 'x');
    if (dom.speeds) {
      Array.prototype.forEach.call(dom.speeds.children, function (b) {
        b.classList.toggle('on', Number(b.dataset.speed) === play.speed);
      });
    }
  }

  function renderSteps() {
    if (!dom.steps || !model) return;
    dom.steps.innerHTML = '';
    var mkItem = function (label, sub, tagText, tagClass, gapText, on, index) {
      var item = mk('div', 'wz-rp-step' + (on ? ' on' : ''));
      item.appendChild(mk('span', 'no', label));
      item.appendChild(mk('span', 'nm', sub));
      if (tagText) item.appendChild(mk('span', 'tag ' + (tagClass || ''), tagText));
      if (gapText) item.appendChild(mk('span', 'gp', gapText));
      item.addEventListener('click', function () { stopPlay(); goto(index); });
      return item;
    };
    var start = mkItem('0', '开局', '', '', '', cursor === 0, 0);
    dom.steps.appendChild(start);
    model.actions.forEach(function (a, i) {
      var on = cursor === i + 1;
      var item = mkItem(String(a.seq), heroNameOf(a),
        sideLabel(a.side) + actionLabel(a.action), a.side, fmtGap(a.gapMs), on, i + 1);
      item.title = (a.nickname || '') + ' · 距上一手 ' + fmtGap(a.gapMs) + (a.actedAt ? ' · ' + fmtClock(a.actedAt) : '');
      dom.steps.appendChild(item);
    });
    var on0 = dom.steps.querySelector('.wz-rp-step.on');
    if (on0 && on0.scrollIntoView) {
      try { on0.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
    }
  }

  /** 唯一的重建入口：把盘面整体重画到游标 k（跳转与播放共用同一条路径） */
  function goto(k, fromDrag) {
    if (!model) return;
    var n = clampK(model, k);
    cursor = n;
    var state = stateAt(model, n);
    renderBoard(state, focusAt(model, n));
    renderDetail();
    renderSteps();
    renderTimeline();
    if (fromDrag && play.playing) schedule();      // 播放中拖动 → 以新位置重新计时
    return state;
  }

  /* ============================================================
     八、历史列表
     ============================================================ */

  function avatarEl(heroId, side) {
    var hero = util().heroById ? util().heroById(heroId) : null;
    if (!hero) {
      var ph = mk('div', 'wz-rp-av empty');
      ph.title = '#' + heroId;
      return ph;
    }
    var img = mk('img', 'wz-rp-av');
    img.alt = hero.name;
    img.title = hero.name;
    img.loading = 'lazy';
    img.src = util().avatarUrl ? util().avatarUrl(hero) : '';
    if (util().bindImgFallback) util().bindImgFallback(img, hero.name);
    return img;
  }

  function renderList() {
    if (!dom.cards) return;
    updateTabs();
    dom.cards.innerHTML = '';

    if (!online) {
      dom.cards.appendChild(mk('div', 'wz-rp-empty',
        '离线模式：历史对局需要连接服务器。\n本地 BP / 展示板 / 截图导出都不受影响。'));
      return;
    }
    if (listLoading) {
      dom.cards.appendChild(mk('div', 'wz-rp-empty', '正在读取对局列表…'));
      return;
    }
    if (listError) {
      dom.cards.appendChild(mk('div', 'wz-rp-empty', '读取失败：' + listError));
      return;
    }
    if (!games.length) {
      dom.cards.appendChild(mk('div', 'wz-rp-empty',
        listScope === 'room' ? '这个房间还没有完成的对局。' : '还没有任何对局记录。\n先去「房间」里打完一局吧。'));
      return;
    }

    games.forEach(function (g) {
      var card = mk('button', 'wz-rp-card');
      card.type = 'button';
      var head = mk('div', 'wz-rp-card-head');
      head.appendChild(mk('span', '', (g.roomName || '未命名房间')));
      head.appendChild(mk('span', '', '第 ' + g.gameNo + ' 局'));
      var win = mk('span', 'wz-rp-win ' + (g.winner === 'blue' ? 'blue' : (g.winner === 'red' ? 'red' : 'none')),
        g.winner === 'blue' ? '蓝方胜' : (g.winner === 'red' ? '红方胜' : '未记胜负'));
      head.appendChild(win);
      head.appendChild(mk('span', 'code', g.code || ''));
      card.appendChild(head);

      var when = fmtDateTime(g.finishedAt || g.startedAt);
      card.appendChild(mk('div', 'wz-rp-card-meta',
        [when, MODE_NAME[g.mode] || g.mode || '', g.status === 'done' ? '已结束' : (g.status || ''),
          g.actionsCount ? ('共 ' + g.actionsCount + ' 手') : '']
          .filter(Boolean).join(' · ')));

      var picks = g.picks;
      if (picks) {
        var line = mk('div', 'wz-rp-lineup');
        var lb = mk('div', 'wz-rp-line');
        var lr = mk('div', 'wz-rp-line red');
        for (var i = 0; i < 5; i++) {
          var hb = picks.blue ? picks.blue[i] : null;
          lb.appendChild(hb === undefined || hb === null ? mk('div', 'wz-rp-av empty') : avatarEl(hb, 'blue'));
        }
        for (var j = 0; j < 5; j++) {
          var hr = picks.red ? picks.red[j] : null;
          lr.appendChild(hr === undefined || hr === null ? mk('div', 'wz-rp-av empty') : avatarEl(hr, 'red'));
        }
        line.appendChild(lb);
        line.appendChild(mk('span', 'wz-rp-vs', 'VS'));
        line.appendChild(lr);
        card.appendChild(line);
      } else {
        /* 列表接口只给 actionCount 不给阵容时，别摆一排灰方块装作有数据 */
        card.appendChild(mk('div', 'wz-rp-lineup-hint', '阵容读取中…（点开即可看完整盘面）'));
      }

      card.addEventListener('click', function () { panel.openGame(g.id); });
      card.disabled = g.id === undefined || g.id === null;
      dom.cards.appendChild(card);
    });
    enrichLineups(games);
  }

  /* 列表接口目前只给 actionCount、不给阵容时，按需补拉每局的 actions 反推阵容。
     只补前 8 条、每条只拉一次、失败静默；后端哪天在列表里带上 picks，这里自然不动。 */
  var enriched = {};
  var enrichTimer = null;
  function enrichLineups(list) {
    if (!online || !WZ.net || typeof WZ.net.replay !== 'function') return;
    var todo = list.filter(function (g) {
      return g.id !== undefined && g.id !== null && !g.picks && !enriched[g.id];
    }).slice(0, 8);
    if (!todo.length) return;
    var pending = todo.length;
    todo.forEach(function (g) {
      enriched[g.id] = true;
      WZ.net.replay(g.id).then(function (data) {
        var acts = (data && data.actions) || [];
        if (acts.length) {
          g.picks = picksFromActions(acts);
          if (!g.actionsCount) g.actionsCount = acts.length;
        }
        done();
      }, function () { done(); });
    });
    function done() {
      if (--pending > 0) return;
      /* 攒齐一批再重绘一次，避免 8 张卡各触发一次整表重排 */
      if (enrichTimer) clearTimeout(enrichTimer);
      enrichTimer = setTimeout(function () {
        enrichTimer = null;
        if (panel.isOpen() && view === 'list') renderList();
      }, 60);
    }
  }

  function updateTabs() {    if (!dom.tabs) return;
    var roomCode = WZ.roomUI && WZ.roomUI.roomCode ? WZ.roomUI.roomCode() : null;
    if (dom.tabRoom) {
      dom.tabRoom.classList.toggle('on', listScope === 'room');
      dom.tabRoom.disabled = !roomCode;
      dom.tabRoom.title = roomCode ? ('房间 ' + roomCode + ' 的对局') : '还没有加入任何房间';
    }
    if (dom.tabRecent) dom.tabRecent.classList.toggle('on', listScope === 'recent');
  }

  function loadList(scope) {
    if (scope) listScope = scope;
    var roomCode = WZ.roomUI && WZ.roomUI.roomCode ? WZ.roomUI.roomCode() : null;
    if (listScope === 'room' && !roomCode) listScope = 'recent';

    if (!online || !WZ.net) {
      games = []; listError = ''; listLoading = false;
      renderList();
      return Promise.resolve([]);
    }
    listLoading = true;
    listError = '';
    renderList();
    var p = listScope === 'room' ? WZ.net.history(roomCode) : WZ.net.recentGames();
    return p.then(function (list) {
      listLoading = false;
      games = (list || []).map(normGame).filter(Boolean);
      renderList();
      return games;
    }, function (err) {
      listLoading = false;
      games = [];
      listError = describe(err);
      renderList();
      return [];
    });
  }

  /* ============================================================
     九、视图切换 / 打开关闭
     ============================================================ */

  function setView(v) {
    view = v === 'replay' ? 'replay' : 'list';
    if (dom.listView) dom.listView.hidden = view !== 'list';
    if (dom.replayView) dom.replayView.hidden = view !== 'replay';
    if (dom.back) dom.back.hidden = view !== 'replay';
    if (view === 'replay') {
      setText(dom.title, 'BP 回放');
      fitBoard();
    } else {
      setText(dom.title, '历史对局');
      setText(dom.sub, online ? '' : '离线模式');
      stopPlay();
    }
  }

  function openInModal(payload, gameLabel) {
    model = buildModel(payload || {});
    cursor = model.actions.length;              // 默认停在最后一手：先看到完整阵容
    setView('replay');
    setText(dom.title, 'BP 回放');
    setText(dom.sub, gameLabel || '');
    setPlaying(false);
    goto(cursor);
    fitBoard();
    /* 弹窗刚显示时尺寸可能还没稳定，下一帧再适配一次 */
    if (window.requestAnimationFrame) window.requestAnimationFrame(fitBoard);
    else setTimeout(fitBoard, 30);
  }

  /* ============================================================
     十、键盘（空格播放/暂停、左右单步）
     ============================================================ */

  function onKeyDown(e) {
    if (!panel.isOpen()) return;
    var tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (e.key === 'Escape') { swallow(e); panel.close(); }
      return;
    }
    if (e.key === 'Escape') { swallow(e); panel.close(); return; }
    /* 弹窗开着的时候，空格/方向键一律归回放管：
       否则会顺手触发 main.js 绑在 document 上的倒计时开关与页面滚动 */
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space' ||
      e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      swallow(e);
      if (view !== 'replay' || !model) return;
      if (e.key === 'ArrowLeft') { stopPlay(); goto(cursor - 1); }
      else if (e.key === 'ArrowRight') { stopPlay(); goto(cursor + 1); }
      else togglePlay();
      return;
    }
    if (view !== 'replay' || !model) return;
    if (e.key === 'Home') { swallow(e); stopPlay(); goto(0); return; }
    if (e.key === 'End') { swallow(e); stopPlay(); goto(model.actions.length); return; }
  }

  /* 捕获阶段拦下来：main.js 在 document 上把空格绑成了倒计时，
     不拦的话回放里按空格会顺带开关倒计时 */
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  /* ============================================================
     十一、对外 API
     ============================================================ */

  panel.available = function () { return !!(WZ.net && WZ.net.isOnline && WZ.net.isOnline()); };

  panel.init = function () {
    if (initialized) return panel;
    initialized = true;
    try { injectStyle(); } catch (e) { console.error('[replay] style failed', e); }
    try {
      /* 注意顺序：buildModal() 会整体替换 dom，所以入口按钮要最后挂回去 */
      var entry = buildEntry();
      dom.wrap = buildModal();
      dom.entry = entry;
      if (document.body) document.body.appendChild(dom.wrap);
      else document.addEventListener('DOMContentLoaded', function () {
        if (document.body) document.body.appendChild(dom.wrap);
      });
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', function () { if (panel.isOpen() && view === 'replay') fitBoard(); });
      if (dom.entry) dom.entry.hidden = true;      // 联网确认后再显示
    } catch (e) {
      console.error('[replay] init failed', e);
      return panel;
    }

    var net = WZ.net;
    if (net && typeof net.onStatus === 'function') {
      net.onStatus(function (s) {
        online = !!(s && s.online);
        if (dom.entry) dom.entry.hidden = !online;
        if (panel.isOpen() && view === 'list') renderList();
      });
    } else {
      online = panel.available();
    }
    if (net && typeof net.init === 'function') {
      var p = net.init();
      if (p && typeof p.then === 'function') {
        p.then(function (st) {
          online = !!(st && st.online);
          if (dom.entry) dom.entry.hidden = !online;
          if (panel.isOpen() && view === 'list') renderList();
        }, function () { /* 离线：保持隐藏 */ });
      }
    }
    return panel;
  };

  /** 打开弹窗。scope: 'recent'（默认）| 'room' */
  panel.open = function (scope) {
    if (!dom.wrap) return false;
    dom.wrap.hidden = false;
    setView('list');
    setText(dom.sub, '');
    var roomCode = WZ.roomUI && WZ.roomUI.roomCode ? WZ.roomUI.roomCode() : null;
    if (scope === 'room' && roomCode) listScope = 'room';
    else if (scope) listScope = scope;
    else if (listScope === 'room' && !roomCode) listScope = 'recent';
    loadList(listScope);
    return true;
  };

  panel.close = function () {
    if (!dom.wrap) return false;
    stopPlay();
    dom.wrap.hidden = true;
    return true;
  };

  panel.isOpen = function () { return !!(dom.wrap && !dom.wrap.hidden); };

  /** 历史列表（Promise<Array>）；scope 省略时用当前页签 */
  panel.listGames = function (scope) { return loadList(scope); };

  /** 打开某一局的回放（Promise<boolean>） */
  panel.openGame = function (gameId) {
    if (gameId === undefined || gameId === null || gameId === '') {
      toast('这条对局记录没有 id，无法回放', 'warn');
      return Promise.resolve(false);
    }
    if (!WZ.net || !WZ.net.isOnline || !WZ.net.isOnline()) {
      toast('离线模式：回放需要连接服务器', 'warn');
      return Promise.resolve(false);
    }
    setText(dom.sub, '正在读取回放数据…');
    return WZ.net.replay(gameId).then(function (data) {
      if (!data || !data.game) throw new Error('服务端没有返回回放数据');
      var g = normGame(data.game) || {};
      var label = (g.roomName || '') + (g.code ? ' · ' + g.code : '') + ' · 第 ' + (g.gameNo || 1) + ' 局' +
        '（' + (data.actions ? data.actions.length : 0) + ' 手）';
      openInModal(data, label);
      return true;
    }, function (err) {
      setText(dom.sub, '');
      toast('回放读取失败：' + describe(err), 'err', 3600);
      return false;
    });
  };

  /**
   * 离线/接线用：直接喂一份 {game, actions, order} 进入回放（不联网）。
   * 用户要求的「保存的 BP 数据可以被展示还原」在断网时也能演示。
   */
  panel.load = function (payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (dom.wrap) dom.wrap.hidden = false;
    var g = normGame(payload.game || {}) || {};
    openInModal(payload, (g.roomName || '本地数据') + (g.gameNo ? ' · 第 ' + g.gameNo + ' 局' : ''));
    return true;
  };

  /** 纯函数：把 {game, actions, order} + 游标组装成展示板 state（可直接喂 WZ.board.render） */
  panel.buildBoardState = function (payload, k) {
    var m = buildModel(payload || {});
    return stateAt(m, k === undefined || k === null ? m.actions.length : k);
  };

  panel.boardState = function (k) {
    if (!model) return null;
    return stateAt(model, k === undefined || k === null ? cursor : k);
  };

  panel.step = function () { return cursor; };
  panel.totalSteps = function () { return model ? model.actions.length : 0; };
  panel.state = function () {
    return model ? {
      game: model.game, mode: model.mode, modeName: model.modeName,
      cursor: cursor, total: model.actions.length,
      playing: play.playing, speed: play.speed
    } : null;
  };
  panel.goto = function (k) { stopPlay(); return goto(k); };
  panel.next = function () { stopPlay(); return goto(cursor + 1); };
  panel.prev = function () { stopPlay(); return goto(cursor - 1); };
  panel.play = function () { if (!play.playing) togglePlay(); };
  panel.pause = function () { setPlaying(false); };
  panel.setSpeed = function (x) {
    var v = Number(x) || 1;
    play.speed = v;
    renderTimeline();
    if (play.playing) schedule();
    return v;
  };
  panel.fmtGap = fmtGap;                 // 接线方做自己的列表时可以直接复用
  panel.formatDuration = fmtDuration;

  WZ.replayUI = panel;
})(window.WZ);
