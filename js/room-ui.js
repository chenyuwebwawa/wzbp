/* ============================================================
   wzbp · 房间 / 战队 UI（大厅 · 席位 · 系列赛控制台）
   ------------------------------------------------------------
   为什么这么写：
   · 只新建文件、不改 index.html / ui.js / CSS：入口按钮与抽屉全部由
     JS 动态创建，样式用注入 <style id="wz-room-style"> 的方式带进来，
     类名统一 wz- 前缀，避免污染既有样式。
   · 抽屉复用现有「赛事面板」的 .story-drawer / .sd-head / .sd-body 类，
     观感与既有抽屉完全一致（不用改 CSS 文件就能对齐）。
   · 离线（file:// 或服务端没起来）时入口按钮不显示、所有动作静默降级，
     绝不抛异常、绝不弹窗——站点必须还能当纯静态 BP 台用。
   · 本模块负责「一个房间一条 SSE 订阅」：SSE 的全量 state 既驱动自己的
     渲染，也通过 init({onState}) 转给接线方（lead）去驱动展示板。
   导出面（占位骨架约定 + 接线需要的扩展）：
     available / init / open / close / toggle / isOpen / applyState / roomCode
     + setHandlers / enterRoom / leave / refresh / loadRooms / sendAction / ensureSubscribed
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var panel = {};

  var initialized = false;
  var roomCode = null;        // 当前所在房间号（大写）
  var lastState = null;       // 最近一次全量状态（契约 §4）
  var pendingCode = '';       // ?room=CODE 带过来的邀请码
  var online = false;
  var busy = false;
  var handlers = {};
  var dom = {};
  var subscribedFor = '';     // 已经订阅的房间号（避免重复订阅）
  var wins = [];              // 本系列每局胜负 [{gameNo, winner, status}]
  var lobbyRooms = null;
  var lobbyError = '';
  var styleInjected = false;
  /* 管理员：本机记住上次的账号名，token 只留在 net 的内存里（不写 localStorage） */
  var adminUser = '';
  var adminError = '';
  /* 自动计时：用服务端 remainingMs 起算，本地每秒递减；每次收到 state 校准 */
  var clock = { deadline: 0, seconds: 0, remain: 0, paused: false, ticker: 0, over: false };

  var MODES = [
    { id: 'ranked', name: '排位征召' },
    { id: 'kpl', name: 'KPL 全局 BP' },
    { id: 'peak', name: '巅峰赛' },
    { id: 'random', name: '随机征召' }
  ];
  var MODE_NAME = { ranked: '排位征召', kpl: '全局 BP', peak: '巅峰赛', random: '随机征召' };
  var STATUS_NAME = { waiting: '等待管理员开始', drafting: 'BP 中', finished: '已结束' };
  /* 建房时可选：赛制 + 每步倒计时（契约 §3.1：30..300，0 = 不限时） */
  var TURN_CHOICES = [
    { v: 30, t: '30 秒' }, { v: 45, t: '45 秒' }, { v: 60, t: '60 秒（默认）' },
    { v: 90, t: '90 秒' }, { v: 120, t: '120 秒' }, { v: 0, t: '不限时' }
  ];
  /* 本机记住上次用过的管理员账号名（token 绝不记，避免共用电脑串号） */
  var LAST_ADMIN_USER_KEY = 'wzbp.admin.user';

  /* ------------------------------------------------------------
     基础小工具（不依赖 WZ.util 的加载顺序，各自兜底）
     ------------------------------------------------------------ */

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

  function queryParam(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(String(window.location.search || ''));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function describe(err) {
    if (WZ.net && typeof WZ.net.describe === 'function') return WZ.net.describe(err);
    return err && err.message ? String(err.message) : String(err);
  }

  function sideLabel(side) { return side === 'red' ? '红方' : (side === 'blue' ? '蓝方' : '双方'); }
  function actionLabel(action) { return action === 'pick' ? '选择' : '禁用'; }

  /* 提示条：优先用项目既有 WZ.app.toast；overlay 等没有 WZ.app 的页面用自带兜底 */
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
    } catch (e) { console.log('[room] ' + msg); }
  }

  function copyText(text) {
    if (WZ.util && typeof WZ.util.copyText === 'function') return WZ.util.copyText(text);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error('当前环境不支持复制，请手动选中'));
  }

  /* ------------------------------------------------------------
     样式（注入，不改 CSS 文件）
     ------------------------------------------------------------ */

  var CSS = [
    /* 抽屉沿用 .story-drawer 的结构与观感，只调宽度与顶部对齐 */
    '.wz-room-drawer { width: min(470px, 100vw); }',
    '.wz-room-drawer .sd-body { display: block; }',
    '.wz-net-dot { width: 9px; height: 9px; border-radius: 50%; background: #4b5f80; flex: 0 0 auto; }',
    '.wz-net-dot.on { background: #3ddc84; box-shadow: 0 0 10px rgba(61,220,132,.8); }',
    '.wz-net-dot.warn { background: var(--warn); box-shadow: 0 0 10px rgba(240,166,60,.7); }',
    '.wz-net-dot.off { background: #46536b; }',
    '.wz-badge { display: inline-block; min-width: 17px; margin-left: 6px; padding: 0 5px; border-radius: 9px;',
    '  background: var(--blue); color: #04101f; font-size: 11px; font-weight: 700; text-align: center; line-height: 16px; }',
    '.wz-sec { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--line-soft); }',
    '.wz-sec:last-child { border-bottom: 0; padding-bottom: 0; }',
    '.wz-sec-h { margin: 0 0 8px; font-size: 12.5px; letter-spacing: 1px; color: var(--text-faint); font-weight: 700; }',
    '.wz-hint { color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }',
    '.wz-err { color: #ffc7ce; font-size: 12.5px; line-height: 1.7; word-break: break-all; }',
    '.wz-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }',
    '.wz-row > label { flex: 0 0 62px; font-size: 12.5px; color: var(--text-dim); }',
    '.wz-input, .wz-select { flex: 1 1 auto; min-width: 0; padding: 7px 9px; border-radius: 8px;',
    '  border: 1px solid var(--line); background: var(--panel-2); color: var(--text); font-family: inherit; font-size: 13px; }',
    '.wz-input:focus, .wz-select:focus { outline: none; border-color: var(--blue); }',
    '.wz-btn-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
    '.wz-btn-row .btn { flex: 0 0 auto; }',
    '.wz-code-box { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px;',
    '  background: linear-gradient(135deg, rgba(58,160,255,.14), rgba(255,77,94,.10)); border: 1px solid var(--line); }',
    '.wz-code { font-family: var(--font-num); font-size: 30px; letter-spacing: 7px; font-weight: 800; color: #fff; }',
    '.wz-code-box .wz-code-sub { flex: 1 1 auto; min-width: 0; }',
    '.wz-teams { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }',
    '.wz-team { border: 1px solid var(--line); border-radius: 10px; padding: 8px; background: var(--panel-2); }',
    '.wz-team.blue { border-color: rgba(58,160,255,.38); }',
    '.wz-team.red { border-color: rgba(255,77,94,.38); }',
    '.wz-team-h { display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 6px; }',
    '.wz-team.blue .wz-team-h { color: #a9d6ff; }',
    '.wz-team.red .wz-team-h { color: #ffc3ca; }',
    '.wz-seat { display: flex; align-items: center; gap: 7px; width: 100%; margin-bottom: 5px; padding: 7px 8px;',
    '  border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text);',
    '  font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }',
    '.wz-seat:hover { border-color: #35486a; background: var(--panel-3); }',
    '.wz-seat.me { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(255,201,102,.16); }',
    '.wz-seat.empty { color: var(--text-faint); border-style: dashed; }',
    '.wz-seat-no { flex: 0 0 auto; width: 16px; height: 16px; border-radius: 5px; background: var(--panel-3);',
    '  font-family: var(--font-num); font-size: 11px; text-align: center; line-height: 16px; color: var(--text-dim); }',
    '.wz-seat-nm { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.wz-seat-nm.empty { color: var(--text-faint); }',
    '.wz-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: #3ddc84; }',
    '.wz-dot.off { background: #46536b; }',
    '.wz-me { flex: 0 0 auto; padding: 0 5px; border-radius: 6px; background: rgba(255,201,102,.18); color: var(--gold); font-size: 11px; }',
    '.wz-room-item { display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 6px; padding: 8px 10px;',
    '  border-radius: 9px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text);',
    '  font-family: inherit; font-size: 13px; text-align: left; cursor: pointer; }',
    '.wz-room-item:hover { border-color: var(--blue); background: var(--panel-3); }',
    '.wz-room-item .ri-main { flex: 1 1 auto; min-width: 0; }',
    '.wz-room-item .ri-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.wz-room-item .ri-meta { display: block; margin-top: 2px; font-size: 11.5px; color: var(--text-faint); }',
    '.wz-room-item .ri-code { font-family: var(--font-num); letter-spacing: 2px; color: #a9bcd8; }',
    '.wz-kv { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--text-dim); }',
    '.wz-kv b { color: var(--text); font-weight: 700; }',
    '.wz-progress { margin-top: 6px; height: 6px; border-radius: 4px; background: var(--panel-3); overflow: hidden; }',
    '.wz-progress > i { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--gold)); }',
    '.wz-toast { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%) translateY(14px); z-index: 200;',
    '  padding: 9px 16px; border-radius: 10px; background: rgba(12,18,30,.96); border: 1px solid var(--line);',
    '  color: var(--text); font-size: 13px; opacity: 0; transition: opacity .2s, transform .2s; max-width: 70vw; }',
    '.wz-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }',
    '.wz-toast.err { border-color: #6d2a2d; color: #ffc7ce; }',
    '.wz-toast.warn { border-color: #6b4a1c; color: #ffe0a8; }',
    '.wz-float-entry { position: fixed; right: 14px; bottom: 14px; z-index: 70; }',

    /* ---------- v3：等待开局 / 管理员 / 自动计时 / 全局 BP 记录 ---------- */
    '.wz-banner { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);',
    '  background: var(--panel-2); font-size: 13px; line-height: 1.6; }',
    '.wz-banner .wz-banner-h { font-size: 14px; font-weight: 800; margin-bottom: 3px; }',
    '.wz-banner.wait { border-color: #6b4a1c; background: linear-gradient(135deg, rgba(240,166,60,.14), rgba(240,166,60,.04)); }',
    '.wz-banner.wait .wz-banner-h { color: #ffd894; }',
    '.wz-banner.live { border-color: rgba(61,220,132,.45); background: linear-gradient(135deg, rgba(61,220,132,.13), rgba(61,220,132,.03)); }',
    '.wz-banner.live .wz-banner-h { color: #9df3c5; }',
    '.wz-banner.done { border-color: #35486a; }',
    '.wz-admin-box { padding: 9px 11px; border-radius: 10px; border: 1px dashed var(--line); background: var(--panel-2); }',
    '.wz-admin-box.on { border-style: solid; border-color: rgba(255,201,102,.5); background: rgba(255,201,102,.07); }',
    '.wz-admin-who { font-size: 13px; color: var(--gold); font-weight: 700; }',
    '.wz-launch { width: 100%; margin-top: 8px; padding: 13px; font-size: 16px; font-weight: 800; letter-spacing: 2px; }',
    '.wz-launch[disabled] { opacity: .5; }',
    '.wz-turn { display: flex; align-items: center; gap: 12px; padding: 11px 13px; border-radius: 11px;',
    '  border: 1px solid var(--line); background: var(--panel-2); }',
    '.wz-turn.blue { border-color: rgba(58,160,255,.55); background: linear-gradient(135deg, rgba(58,160,255,.16), rgba(58,160,255,.04)); }',
    '.wz-turn.red { border-color: rgba(255,77,94,.55); background: linear-gradient(135deg, rgba(255,77,94,.16), rgba(255,77,94,.04)); }',
    '.wz-turn .t-main { flex: 1 1 auto; min-width: 0; }',
    '.wz-turn .t-who { font-size: 15px; font-weight: 800; }',
    '.wz-turn .t-sub { margin-top: 2px; font-size: 12px; color: var(--text-dim); }',
    '.wz-turn .t-step { font-family: var(--font-num); font-size: 12px; color: var(--text-faint); }',
    '.wz-clock { flex: 0 0 auto; min-width: 78px; text-align: right; font-family: var(--font-num);',
    '  font-size: 30px; font-weight: 800; line-height: 1; color: var(--text); }',
    '.wz-clock.warn { color: var(--warn); }',
    '.wz-clock.over { color: var(--red); animation: wzPulse 1s infinite; }',
    '.wz-clock.off { font-size: 15px; color: var(--text-faint); }',
    '@keyframes wzPulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }',
    '.wz-locked { margin-top: 8px; padding: 10px 12px; border-radius: 9px; border: 1px dashed #6b4a1c;',
    '  background: rgba(240,166,60,.07); color: #ffd894; font-size: 12.5px; line-height: 1.7; }',
    '.wz-global { padding: 10px 11px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel-2); }',
    '.wz-global-h { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; margin-bottom: 7px; }',
    '.wz-global-h .b { color: #a9d6ff; font-weight: 700; }',
    '.wz-global-h .r { color: #ffc3ca; font-weight: 700; }',
    '.wz-global-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }',
    '.wz-global-row:last-child { margin-bottom: 0; }',
    '.wz-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px 2px 3px; border-radius: 999px;',
    '  border: 1px solid var(--line); background: var(--panel); font-size: 11.5px; color: var(--text-dim); }',
    '.wz-chip img { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; background: var(--panel-3); }',
    '.wz-chip.blue { border-color: rgba(58,160,255,.42); }',
    '.wz-chip.red { border-color: rgba(255,77,94,.42); }',
    '.wz-chip.none { border-style: dashed; color: var(--text-faint); }',
    '.wz-sec.wz-dim { opacity: .55; }',
    '.wz-lock-note { margin-top: 6px; color: #ffd894; font-size: 12px; }'
  ].join('\n');

  function injectStyle() {
    if (styleInjected || document.getElementById('wz-room-style')) { styleInjected = true; return; }
    var s = document.createElement('style');
    s.id = 'wz-room-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
    styleInjected = true;
  }

  /* ------------------------------------------------------------
     入口按钮 / 抽屉骨架
     ------------------------------------------------------------ */

  function buildEntry() {
    var btn = mk('button', 'btn btn-ghost', '房间');
    btn.type = 'button';
    btn.id = 'btnRoomPanel';
    btn.title = '联机房间：建房 / 加入 / 战队席位 / 系列赛';
    var badge = mk('span', 'wz-badge');
    badge.id = 'wzRoomBadge';
    badge.hidden = true;
    btn.appendChild(badge);
    btn.addEventListener('click', function () { panel.toggle(); });

    var host = document.querySelector('.appbar-right');
    var ref = document.getElementById('btnStoryPanel');
    if (host && ref && ref.parentNode === host) host.insertBefore(btn, ref.nextSibling);
    else if (host) host.appendChild(btn);
    else {
      /* 没有顶栏的页面（如 overlay.html）：退化成一个浮动入口，功能不丢 */
      btn.className = 'btn btn-ghost wz-float-entry';
      if (document.body) document.body.appendChild(btn);
    }
    btn.hidden = true;                      // 联网确认后才显示
    return btn;
  }

  function buildDrawer() {
    var d = mk('aside', 'story-drawer wz-room-drawer');
    d.id = 'wzRoomDrawer';
    d.hidden = true;

    var head = mk('div', 'sd-head');
    var dot = mk('span', 'wz-net-dot');
    dot.id = 'wzNetDot';
    var title = mk('span', 'sd-title', '联机房间');
    title.id = 'wzRoomTitle';
    var btnRefresh = mk('button', 'btn btn-ghost', '刷新');
    btnRefresh.type = 'button';
    btnRefresh.id = 'wzRoomRefresh';
    var btnClose = mk('button', 'btn btn-ghost', '关闭');
    btnClose.type = 'button';
    btnClose.id = 'wzRoomClose';
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(btnRefresh);
    head.appendChild(btnClose);

    var body = mk('div', 'sd-body');
    body.id = 'wzRoomBody';

    d.appendChild(head);
    d.appendChild(body);

    btnClose.addEventListener('click', function () { panel.close(); });
    btnRefresh.addEventListener('click', function () { panel.refresh(); });
    return d;
  }

  /* ------------------------------------------------------------
     事件转发 / 订阅
     ------------------------------------------------------------ */

  function setHandlers(o) {
    o = o || {};
    ['onState', 'onAction', 'onPresence', 'onGame', 'onStatus', 'onError'].forEach(function (k) {
      if (typeof o[k] === 'function') handlers[k] = o[k];
    });
  }

  function forward(name, args) {
    var fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn.apply(null, args || []); }
    catch (e) { console.error('[room] handler ' + name + ' failed', e); }
  }

  /* 一个房间一条 SSE；重复调用是幂等的（契约 §5）。
     注意必须写成函数声明：写成 `panel.x = function x(){}` 时名字只在自身作用域可见，
     内部裸调用 x() 会抛 ReferenceError（被 try/catch 吞掉后表现为「静默不订阅」）。 */
  function ensureSubscribed() {
    if (!online || !roomCode) return false;
    if (subscribedFor === roomCode && WZ.net && WZ.net.connection && WZ.net.connection() !== 'idle') return true;
    var net = WZ.net;
    if (!net || typeof net.subscribe !== 'function') return false;
    var handle = net.subscribe(roomCode, {
      onState: function (s) { panel.applyState(s); },
      onAction: function (action, game) {
        forward('onAction', [action, game]);
        if (lastState && lastState.game) lastState.game.nextAction = null;   // 由随后的 state 修正
      },
      onPresence: function (players) {
        forward('onPresence', [players]);
        if (lastState) { lastState.players = players; if (panel.isOpen()) render(); }
      },
      onGame: function (game) {
        forward('onGame', [game]);
        loadSeries();                                   // 换局后刷新每局胜负记录
      },
      onOpen: function (info) {
        forward('onStatus', [WZ.net.state()]);
        if (info && info.reconnected) toast('实时连接已恢复', 'ok');
      },
      onError: function (err) {
        forward('onError', [err]);
        if (panel.isOpen()) render();                   // 顶部圆点反映连接状态
      }
    });
    subscribedFor = handle ? roomCode : '';
    return !!handle;
  }
  panel.ensureSubscribed = ensureSubscribed;

  /* ------------------------------------------------------------
     数据加载
     ------------------------------------------------------------ */

  function loadRooms() {
    if (!online) { lobbyRooms = null; lobbyError = ''; return Promise.resolve([]); }
    return WZ.net.listRooms().then(function (list) {
      lobbyRooms = list || [];
      lobbyError = '';
      if (panel.isOpen() && !roomCode) render();
      return lobbyRooms;
    }, function (err) {
      lobbyRooms = [];
      lobbyError = describe(err);
      if (panel.isOpen() && !roomCode) render();
      return [];
    });
  }

  var stateLoading = null;    // 防止「打开抽屉 + 渲染」重复打同一个 state 请求

  function loadState() {
    if (!roomCode || !online) return Promise.resolve(null);
    if (stateLoading) return stateLoading;
    var c = roomCode;
    stateLoading = WZ.net.getState(c).then(function (s) {
      stateLoading = null;
      if (roomCode !== c) return null;
      panel.applyState(s);
      return s;
    }, function (err) {
      stateLoading = null;
      if (roomCode !== c) return null;
      if (err && err.status === 404) {
        roomCode = null; lastState = null; subscribedFor = '';
        toast('房间已不存在或已解散', 'warn');
        render();
      } else {
        toast(describe(err), 'err');
      }
      return null;
    });
    return stateLoading;
  }

  /* 每局胜负记录没有单独的接口，用 /history 反推（契约 §3） */
  var seriesLoading = false;
  function loadSeries() {
    if (!roomCode || !online || seriesLoading) { if (!roomCode || !online) wins = []; return; }
    var c = roomCode;
    seriesLoading = true;
    WZ.net.history(c).then(function (games) {
      seriesLoading = false;
      if (roomCode !== c) return;
      wins = (games || []).map(function (g) {
        return {
          gameNo: g && g.gameNo !== undefined && g.gameNo !== null ? Number(g.gameNo) : null,
          winner: (g && g.winner) || null,
          status: (g && g.status) || ''
        };
      }).filter(function (g) { return g.gameNo !== null && !isNaN(g.gameNo); })
        .sort(function (a, b) { return a.gameNo - b.gameNo; });
      if (panel.isOpen()) render();
    }, function () { seriesLoading = false; /* 历史拿不到不影响房间主流程 */ });
  }

  /* ------------------------------------------------------------
     动作
     ------------------------------------------------------------ */

  function createRoom() {
    if (busy || !online) return;
    var nameEl = document.getElementById('wzNewName');
    var modeEl = document.getElementById('wzNewMode');
    var boEl = document.getElementById('wzNewBo');
    var turnEl = document.getElementById('wzNewTurn');
    var auEl = document.getElementById('wzNewAdminUser');
    var apEl = document.getElementById('wzNewAdminPass');
    var nickEl = document.getElementById('wzNick');
    if (nickEl) WZ.net.setName(nickEl.value);

    /* 管理员账号是建房必填项（契约 §3.0.1）——先在本地挡一道，别白跑一趟服务器 */
    var au = auEl ? String(auEl.value || '').trim() : '';
    var ap = apEl ? String(apEl.value || '') : '';
    if (!/^[A-Za-z0-9_]{3,20}$/.test(au)) {
      toast('管理员账号要 3~20 位，只能用字母、数字、下划线', 'err', 4200);
      if (auEl) auEl.focus();
      return;
    }
    if (ap.length < 6 || ap.length > 64) {
      toast('管理员密码要 6~64 位', 'err', 4200);
      if (apEl) apEl.focus();
      return;
    }

    busy = true;
    render();
    WZ.net.createRoom({
      name: nameEl ? nameEl.value : '',
      mode: modeEl ? modeEl.value : 'ranked',
      seriesCount: boEl ? Number(boEl.value) : 1,
      turnSeconds: turnEl ? Number(turnEl.value) : 60,
      adminUser: au,
      adminPass: ap,
      nickname: WZ.net.myName()
    }).then(function (res) {
      var code = res && res.room && res.room.code;
      if (!code) throw new Error('服务端没有返回房间号');
      roomCode = String(code).toUpperCase();
      pendingCode = '';
      adminUser = au;
      try { WZ.util.store.set(LAST_ADMIN_USER_KEY, au); } catch (e) { /* 忽略 */ }
      /* 建房时服务端会把 adminToken 一并返回，这里自己就是管理员 */
      if (res.adminToken && WZ.net.setAdminToken) WZ.net.setAdminToken(res.adminToken, au, roomCode);
      toast('房间已创建：' + roomCode + '　你是管理员「' + au + '」，等队员加入后点「开始 BP」', 'ok', 5200);
      return WZ.net.joinRoom(roomCode, { team: 'auto' });
    }).then(function () {
      busy = false;
      return loadState();
    }).then(function () {
      loadSeries();
      render();
    }).catch(function (err) {
      busy = false;
      toast(describe(err), 'err');
      render();
    });
  }

  function joinRoom(code, team, slot) {
    if (busy || !online) return;
    var c = String(code || '').trim().toUpperCase();
    if (!c) return;
    var nickEl = document.getElementById('wzNick');
    if (nickEl) WZ.net.setName(nickEl.value);
    busy = true;
    render();
    var opts = { team: team || 'auto' };
    if (slot !== undefined && slot !== null) opts.slot = slot;
    WZ.net.joinRoom(c, opts).then(function () {
      roomCode = c;
      pendingCode = '';
      toast('已加入房间 ' + c, 'ok');
      busy = false;
      return loadState();
    }).then(function () {
      loadSeries();
      render();
    }).catch(function (err) {
      busy = false;
      toast(describe(err), 'err');
      render();
    });
  }

  /* 换座：契约 §3.2 规定同一 playerKey 再次 join 会「保持原队伍与位置」，
     所以想挪到别的空位必须「先离后进」，否则看起来像点了没反应。 */
  function moveSeat(side, slot) {
    if (busy || !online || !roomCode) return;
    var me = lastState && lastState.me;
    if (!me) { joinRoom(roomCode, side, slot); return; }
    if (me.team === side && Number(me.slot) === Number(slot)) { toast('这是你的位置', 'warn'); return; }
    var c = roomCode;
    busy = true;
    render();
    WZ.net.leaveRoom(c).then(function () {
      return WZ.net.joinRoom(c, { team: side, slot: slot });
    }).then(function () {
      busy = false;
      toast('已换到' + sideLabel(side) + ' ' + (slot + 1) + ' 号位', 'ok');
      return loadState();
    }).catch(function (err) {
      busy = false;
      toast('换座失败：' + describe(err), 'err');
      loadState();
    });
  }

  function leaveRoom() {    if (!roomCode) return;
    var c = roomCode;
    if (!window.confirm('确定离开房间 ' + c + ' 吗？（座位会释放给别人）')) return;
    WZ.net.leaveRoom(c).then(function () {
      toast('已离开房间 ' + c, 'ok');
    }, function (err) {
      toast(describe(err), 'err');
    }).then(function () {
      if (roomCode === c) { roomCode = null; lastState = null; }
      subscribedFor = '';
      if (WZ.net && typeof WZ.net.unsubscribe === 'function') WZ.net.unsubscribe();
      loadRooms();
      render();
    });
  }

  function doUndo() {
    if (!roomCode) return;
    if (!window.confirm('撤销本局最后一手？')) return;
    WZ.net.undo(roomCode).then(function (res) {
      toast('已撤销' + (res && res.removed ? '：' + (res.removed.heroName || '') : '上一手'), 'ok');
    }, function (err) { toast(describe(err), 'err'); });
  }

  function doNextGame() {
    if (!roomCode) return;
    var sel = document.getElementById('wzWinner');
    var winner = sel && sel.value ? sel.value : '';
    var label = winner === 'blue' ? '蓝方胜' : (winner === 'red' ? '红方胜' : '不记胜负');
    if (!window.confirm('结束本局并开始下一局？（本局记为：' + label + '）')) return;
    WZ.net.nextGame(roomCode, { winner: winner || undefined }).then(function (res) {
      var g = res && res.game;
      toast(g && g.status === 'done' ? '系列赛已结束' : '已进入第 ' + ((g && g.gameNo) || '') + ' 局', 'ok');
      return loadState();
    }).then(function () { loadSeries(); }, function (err) { toast(describe(err), 'err'); });
  }

  function doFinish() {
    if (!roomCode) return;
    if (!window.confirm('直接结束整个系列赛？')) return;
    WZ.net.finishSeries(roomCode).then(function () {
      toast('系列赛已结束', 'ok');
      return loadState();
    }).then(function () { loadSeries(); }, function (err) { toast(describe(err), 'err'); });
  }

  function doShuffle() {
    if (!roomCode) return;
    WZ.net.shuffle(roomCode).then(function () {
      toast('已重新随机本局顺序', 'ok');
      return loadState();
    }).catch(function (err) { toast(describe(err), 'err'); });
  }

  function copyInvite() {
    var link = inviteLink();
    copyText(link).then(function () { toast('邀请链接已复制：' + link, 'ok', 3200); },
      function () { toast('复制失败，请手动复制：' + link, 'warn', 4200); });
    return link;
  }

  function inviteLink() {
    /* 邀请链接形如「当前地址?room=CODE」；丢掉 hash 与已有的 query，避免叠加 */
    var base = '';
    try { base = String(window.location.href || '').split('#')[0].split('?')[0]; }
    catch (e) { base = ''; }
    return base + '?room=' + encodeURIComponent(roomCode || '');
  }

  /* ------------------------------------------------------------
     v3：管理员 + 开局 + 自动计时 + 全局 BP 记录
     ------------------------------------------------------------ */

  function isAdmin() {
    return !!(lastState && lastState.admin && lastState.admin.you);
  }

  /* 用服务端 remainingMs 校准本地倒计时（不信任本机时钟绝对值，只信任「还剩多久」） */
  function syncClock(game) {
    var turn = (game && game.turn) || null;
    clock.seconds = turn && typeof turn.seconds === 'number' ? turn.seconds : 0;
    clock.paused = !!(lastState && lastState.room && lastState.room.paused);
    if (!turn || typeof turn.remainingMs !== 'number' || clock.seconds <= 0) {
      clock.deadline = 0;
      clock.remain = 0;
      clock.over = false;
      return;
    }
    clock.deadline = Date.now() + Math.max(0, turn.remainingMs);
    clock.remain = Math.max(0, Math.round(turn.remainingMs / 1000));
    clock.over = turn.remainingMs <= 0;
  }

  function startTicker() {
    if (clock.ticker) return;
    clock.ticker = setInterval(function () {
      if (!clock.deadline) return;
      var ms = clock.deadline - Date.now();
      var sec = Math.max(0, Math.ceil(ms / 1000));
      if (sec === clock.remain) return;
      clock.remain = sec;
      clock.over = ms <= 0;
      paintClock();
    }, 250);
  }

  function stopTicker() {
    if (clock.ticker) { clearInterval(clock.ticker); clock.ticker = 0; }
  }

  /* 只更新倒计时那一个节点，不整树重绘——否则输入框会掉焦点 */
  function paintClock() {
    var el = document.getElementById('wzClock');
    if (!el) return;
    if (!clock.deadline || clock.seconds <= 0) {
      el.className = 'wz-clock off';
      el.textContent = clock.paused ? '已暂停' : '不限时';
      return;
    }
    var m = Math.floor(clock.remain / 60);
    var sec = clock.remain % 60;
    el.textContent = (m > 0 ? m + ':' + (sec < 10 ? '0' : '') + sec : String(clock.remain) + 's');
    el.className = 'wz-clock' + (clock.over ? ' over' : (clock.remain <= 10 ? ' warn' : ''));
    if (clock.over && el.title !== '超时') {
      el.title = '超时';
      toast('本步超时了（不会自动替你选，请尽快落子）', 'warn', 3000);
    }
  }

  function doAdminLogin() {
    if (busy || !online || !roomCode) return;
    var u = document.getElementById('wzAdminUser');
    var p = document.getElementById('wzAdminPass');
    var user = u ? String(u.value || '').trim() : '';
    var pass = p ? String(p.value || '') : '';
    adminError = '';
    if (!user || !pass) { adminError = '请填管理员账号和密码'; render(); return; }
    busy = true;
    render();
    WZ.net.adminLogin(roomCode, user, pass).then(function (res) {
      busy = false;
      adminUser = user;
      try { WZ.util.store.set(LAST_ADMIN_USER_KEY, user); } catch (e) { /* 忽略 */ }
      toast('管理员登录成功：' + user, 'ok', 3000);
      return loadState();
    }).then(function () { render(); }).catch(function (err) {
      busy = false;
      adminError = describe(err);
      toast(adminError, 'err', 4200);
      render();
    });
  }

  function doAdminLogout() {
    WZ.net.adminLogout(roomCode);
    adminError = '';
    toast('已退出管理员', 'ok');
    render();
  }

  function doLaunch() {
    if (busy || !online || !roomCode) return;
    busy = true;
    render();
    WZ.net.launchRoom(roomCode).then(function () {
      busy = false;
      toast('BP 开始！按顺序轮流 ban/pick', 'ok', 3200);
      return loadState();
    }).then(function () { loadSeries(); render(); }).catch(function (err) {
      busy = false;
      toast(describe(err), 'err', 4200);
      render();
    });
  }

  function doPause(next) {
    WZ.net.pauseRoom(roomCode, next).then(function () {
      toast(next ? '已暂停计时' : '已继续', 'ok');
      return loadState();
    }).then(function () { render(); }).catch(function (err) { toast(describe(err), 'err'); });
  }

  /* 管理员登录区（未开局/已开局都要能看到并能登录） */
  function adminSection(st, room) {
    var sec = mk('section', 'wz-sec');
    sec.appendChild(mk('h4', 'wz-sec-h', '管理员'));

    var box = mk('div', 'wz-admin-box' + (isAdmin() ? ' on' : ''));
    if (isAdmin()) {
      var row = mk('div', 'wz-row');
      row.appendChild(mk('span', 'wz-admin-who', '管理员：' + (WZ.net.adminUser() || adminUser || '已登录')));
      box.appendChild(row);
      var rowB = mk('div', 'wz-btn-row');
      var out = mk('button', 'btn btn-ghost', '退出管理员');
      out.type = 'button';
      out.addEventListener('click', doAdminLogout);
      rowB.appendChild(out);
      box.appendChild(rowB);
      sec.appendChild(box);

      /* 未开局 → 大按钮「开始 BP」 */
      if (!room.launched && room.status !== 'finished') {
        var launch = mk('button', 'btn btn-primary wz-launch', '开 始  B P');
        launch.type = 'button';
        launch.id = 'wzLaunchBtn';
        launch.disabled = !!busy;
        launch.title = (st.players || []).length
          ? '点这里让所有人进入 BP（之后按王者征召顺序轮流 ban/pick）'
          : '还没有队员入座，可以先开始也可以等一会儿';
        launch.addEventListener('click', doLaunch);
        sec.appendChild(launch);
        sec.appendChild(mk('div', 'wz-hint', '点「开始 BP」后，所有人的操作面板才会解锁，并且每步自动倒计时。'));
      }
    } else {
      var hint = mk('div', 'wz-hint',
        '只有管理员能开局与暂停。若你是本房管理员，请用建房时填的账号登录：');
      box.appendChild(hint);
      var r1 = mk('div', 'wz-row');
      r1.appendChild(mk('label', '', '账号'));
      var u = mk('input', 'wz-input');
      u.id = 'wzAdminUser';
      u.type = 'text';
      u.maxLength = 20;
      u.autocomplete = 'off';
      u.value = WZ.net.adminUser() || adminUser || (function () {
        try { return WZ.util.store.get(LAST_ADMIN_USER_KEY) || ''; } catch (e) { return ''; }
      })();
      u.placeholder = '建房时填的管理员账号';
      r1.appendChild(u);
      box.appendChild(r1);
      var r2 = mk('div', 'wz-row');
      r2.appendChild(mk('label', '', '密码'));
      var p = mk('input', 'wz-input');
      p.id = 'wzAdminPass';
      p.type = 'password';
      p.maxLength = 64;
      p.autocomplete = 'current-password';
      p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doAdminLogin(); });
      r2.appendChild(p);
      box.appendChild(r2);
      if (adminError) box.appendChild(mk('div', 'wz-err', adminError));
      var rb = mk('div', 'wz-btn-row');
      var login = mk('button', 'btn btn-primary', busy ? '登录中…' : '管理员登录');
      login.type = 'button';
      login.id = 'wzAdminLoginBtn';
      login.disabled = !!busy;
      login.addEventListener('click', doAdminLogin);
      rb.appendChild(login);
      box.appendChild(rb);
      sec.appendChild(box);
      if (!room.launched && room.status !== 'finished') {
        var locked = mk('div', 'wz-locked', '⏳ 等待管理员开始 BP —— 现在还不能 ban/pick。请先在下面加入队伍。');
        sec.appendChild(locked);
      }
    }
    return sec;
  }

  /* 当前轮到谁 / 第几手 / 倒计时 */
  function turnSection(st, room) {
    var sec = mk('section', 'wz-sec');
    var game = st.game || {};
    var acts = st.actions || [];
    var order = (st.series && st.series.order) || [];
    var total = order.length || 0;
    var na = game.nextAction;

    var side = na && na.side === 'both' ? 'both' : (na ? na.side : null);
    var cls = side === 'blue' ? ' blue' : (side === 'red' ? ' red' : '');
    var box = mk('div', 'wz-turn' + cls);

    var main = mk('div', 't-main');
    var who;
    if (game.done || room.status === 'finished') who = '本局 BP 已结束';
    else if (!room.launched) who = '尚未开始（等管理员）';
    else if (na) who = '轮到 ' + sideLabel(na.side) + ' ' + actionLabel(na.action);
    else who = '等待中';
    main.appendChild(mk('div', 't-who', who));

    var subText = '';
    if (room.launched && na) {
      subText = '请' + sideLabel(na.side) + '在英雄列表里点英雄，然后选「' + actionLabel(na.action) + '」';
      /* 不是自己回合时把原因说清楚，别只是灰着 */
      var me = st.me;
      if (me && me.team && na.side !== 'both' && me.team !== na.side) {
        subText = '现在还轮不到你（你是' + sideLabel(me.team) + '），等' + sideLabel(na.side) + '先操作';
      }
    } else if (!room.launched) {
      subText = '管理员点「开始 BP」后才解锁操作';
    }
    if (subText) main.appendChild(mk('div', 't-sub', subText));
    if (total) {
      main.appendChild(mk('div', 't-step',
        '第 ' + Math.min(acts.length + (game.done ? 0 : 1), total) + ' 手 / 共 ' + total + ' 手' +
        (clock.paused ? ' · 已暂停' : '')));
    }
    box.appendChild(main);

    var ck = mk('div', 'wz-clock off', '—');
    ck.id = 'wzClock';
    box.appendChild(ck);
    sec.appendChild(box);

    if (total) {
      var bar = mk('div', 'wz-progress');
      var fill = mk('i', '');
      fill.style.width = Math.min(100, Math.round(acts.length / total * 100)) + '%';
      bar.appendChild(fill);
      sec.appendChild(bar);
    }
    paintClock();
    return sec;
  }

  /* 全局 BP 记录：本系列赛各队已选过的英雄（跨局累计） */
  function globalSection(st, room) {
    var game = st.game || {};
    var order0 = (st.series && st.series.order) || [];
    var isGlobal = !!game.global || room.mode === 'kpl';
    if (!isGlobal) return null;

    var used = game.globalUsed || { blue: [], red: [] };
    var sec = mk('section', 'wz-sec');
    sec.appendChild(mk('h4', 'wz-sec-h', '全局 BP 记录（跨局累计，选过就不能再选）'));

    var box = mk('div', 'wz-global');
    var head = mk('div', 'wz-global-h');
    head.appendChild(mk('span', 'b', '蓝方已用 ' + ((used.blue || []).length) + ' 个'));
    head.appendChild(mk('span', 'r', '红方已用 ' + ((used.red || []).length) + ' 个'));
    box.appendChild(head);

    [['blue', 'b'], ['red', 'r']].forEach(function (pair) {
      var side = pair[0];
      var rowEl = mk('div', 'wz-global-row');
      var list = used[side] || [];
      if (!list.length) {
        rowEl.appendChild(mk('span', 'wz-chip none', sideLabel(side) + '：还没选过人'));
      } else {
        list.forEach(function (id) {
          var hero = WZ.util.heroById(id);
          var chip = mk('span', 'wz-chip ' + side);
          if (hero && hero.avatar) {
            var img = document.createElement('img');
            img.src = hero.avatar;
            img.alt = '';
            img.loading = 'lazy';
            chip.appendChild(img);
          }
          chip.appendChild(document.createTextNode(hero ? hero.name : ('#' + id)));
          chip.title = (hero ? hero.name : id) + '：已被' + sideLabel(side) +
            '在本系列赛选用，' + sideLabel(side) + '后续小局不能再选（禁用不受影响）';
          rowEl.appendChild(chip);
        });
      }
      box.appendChild(rowEl);
    });
    sec.appendChild(box);
    sec.appendChild(mk('div', 'wz-hint',
      '规则：本方选过的英雄本方后续小局不能再选；对方选过的不受影响；上一局被 ban 的英雄本局仍可选。'));
    return sec;
  }


  function render() {
    if (!dom.body) return;
    try {
      updateHead();
      dom.body.innerHTML = '';
      if (!online) { stopTicker(); renderOffline(); }
      else if (roomCode) { startTicker(); renderRoom(); }
      else { stopTicker(); renderLobby(); }
      updateEntry();
    } catch (e) {
      console.error('[room] render failed', e);
    }
  }

  function updateHead() {
    var dot = dom.dot;
    if (dot) {
      var cls = 'wz-net-dot';
      if (!online) cls += ' off';
      else if (WZ.net && WZ.net.connection && WZ.net.connection() === 'open') cls += ' on';
      else if (online) cls += ' warn';
      dot.className = cls;
      dot.title = online
        ? ('已连接服务器' + (WZ.net.base && WZ.net.base() ? '（' + WZ.net.base() + '）' : '') +
           ' · 实时连接：' + (WZ.net.connection ? WZ.net.connection() : '-'))
        : '离线模式';
    }
    var box = dom.btn ? dom.btn.querySelector('.wz-badge') : null;
    if (box) {
      var n = lastState && lastState.players ? lastState.players.length : 0;
      if (roomCode && n) { box.hidden = false; setText(box, String(n)); }
      else box.hidden = true;
    }
    var title = dom.title;
    if (title) {
      if (!online) setText(title, '联机房间（离线）');
      else if (roomCode && lastState && lastState.room) {
        setText(title, (lastState.room.name || '房间') + ' · ' + roomCode);
      } else if (roomCode) setText(title, '房间 ' + roomCode);
      else setText(title, '联机房间');
    }
  }

  function updateEntry() {
    if (!dom.btn) return;
    dom.btn.hidden = !online && !roomCode;
  }

  function renderOffline() {
    var s = dom.body;
    var sec = mk('section', 'wz-sec');
    sec.appendChild(mk('h4', 'wz-sec-h', '当前离线模式'));
    sec.appendChild(mk('div', 'wz-hint',
      '未能连接服务器，联网功能暂不可用；本地 BP / 展示板 / 采集窗一切照常工作。'));
    var why = (WZ.net && WZ.net.state && WZ.net.state().lastError) ? WZ.net.state().lastError.message : '';
    if (why) sec.appendChild(mk('div', 'wz-hint', '原因：' + why));
    sec.appendChild(mk('div', 'wz-hint',
      '提示：file:// 打开时浏览器禁止访问本机服务（契约 §0），请通过服务器地址以 http(s) 访问；' +
      '若服务端刚启动，点下面的按钮重试即可。'));
    var row = mk('div', 'wz-btn-row');
    var retry = mk('button', 'btn btn-primary', '重试连接');
    retry.type = 'button';
    retry.addEventListener('click', function () {
      setText(retry, '正在连接…');
      WZ.net.reprobe().then(function (st) {
        setText(retry, '重试连接');
        toast(st && st.online ? '已连接服务器' : '仍未连接上服务器', st && st.online ? 'ok' : 'warn');
        render();
      });
    });
    row.appendChild(retry);
    sec.appendChild(row);
    s.appendChild(sec);
  }

  function renderLobby() {
    var s = dom.body;

    /* 昵称 */
    var secId = mk('section', 'wz-sec');
    secId.appendChild(mk('h4', 'wz-sec-h', '我的昵称'));
    var row0 = mk('div', 'wz-row');
    row0.appendChild(mk('label', '', '昵称'));
    var nick = mk('input', 'wz-input');
    nick.id = 'wzNick';
    nick.type = 'text';
    nick.maxLength = 20;
    nick.value = WZ.net.myName();
    nick.placeholder = '1..20 字符';
    nick.addEventListener('change', function () {
      toast('昵称已保存：' + WZ.net.setName(nick.value), 'ok');
      nick.value = WZ.net.myName();
    });
    row0.appendChild(nick);
    secId.appendChild(row0);
    s.appendChild(secId);

    /* 邀请码（?room=CODE） */
    if (pendingCode) {
      var secInv = mk('section', 'wz-sec');
      secInv.appendChild(mk('h4', 'wz-sec-h', '有人邀请你加入房间'));
      var box = mk('div', 'wz-code-box');
      var sub = mk('div', 'wz-code-sub');
      sub.appendChild(mk('div', 'wz-code', pendingCode));
      var line = pendingInfo
        ? (pendingInfo.name + ' · ' + (MODE_NAME[pendingInfo.mode] || pendingInfo.mode) +
           ' · BO' + pendingInfo.seriesCount + ' · 已有 ' + pendingInfo.players + ' 人' +
           (pendingInfo.launched ? ' · 已开局' : ' · 等管理员开局'))
        : '点右侧按钮加入，然后在蓝方/红方点一个空位坐下';
      sub.appendChild(mk('div', 'wz-hint', line));
      sub.appendChild(mk('div', 'wz-hint',
        '加入后你就是「队伍成员」；要开始 BP 得等管理员点「开始 BP」。'));
      box.appendChild(sub);
      var go = mk('button', 'btn btn-primary', '加入房间');
      go.type = 'button';
      go.addEventListener('click', function () {
        pendingInfo = null;
        joinRoom(pendingCode, 'auto');
      });
      box.appendChild(go);
      secInv.appendChild(box);
      s.appendChild(secInv);
    }

    /* 建房 */
    var secNew = mk('section', 'wz-sec');
    secNew.appendChild(mk('h4', 'wz-sec-h', '创建房间'));
    var r1 = mk('div', 'wz-row');
    r1.appendChild(mk('label', '', '房间名'));
    var nameIn = mk('input', 'wz-input');
    nameIn.id = 'wzNewName';
    nameIn.type = 'text';
    nameIn.maxLength = 80;
    nameIn.placeholder = '例如：周五训练赛';
    r1.appendChild(nameIn);
    secNew.appendChild(r1);

    var r2 = mk('div', 'wz-row');
    r2.appendChild(mk('label', '', '赛制'));
    var modeSel = mk('select', 'wz-select');
    modeSel.id = 'wzNewMode';
    MODES.forEach(function (m) {
      var o = mk('option', '', m.name);
      o.value = m.id;
      modeSel.appendChild(o);
    });
    modeSel.value = 'ranked';
    r2.appendChild(modeSel);
    secNew.appendChild(r2);

    var r3 = mk('div', 'wz-row');
    r3.appendChild(mk('label', '', '局数'));
    var boSel = mk('select', 'wz-select');
    boSel.id = 'wzNewBo';
    for (var i = 1; i <= 9; i++) {
      var o2 = mk('option', '', 'BO' + i);
      o2.value = String(i);
      boSel.appendChild(o2);
    }
    boSel.value = '1';
    r3.appendChild(boSel);
    secNew.appendChild(r3);
    secNew.appendChild(mk('div', 'wz-hint', 'BO几 就是这轮要打几局；每局都单独 BP，全局 BP 的记录跨局累计。'));

    var r4 = mk('div', 'wz-row');
    r4.appendChild(mk('label', '', '每步限时'));
    var turnSel = mk('select', 'wz-select');
    turnSel.id = 'wzNewTurn';
    TURN_CHOICES.forEach(function (c) {
      var o3 = mk('option', '', c.t);
      o3.value = String(c.v);
      turnSel.appendChild(o3);
    });
    turnSel.value = '60';
    r4.appendChild(turnSel);
    secNew.appendChild(r4);

    /* 管理员账号：建房的人就是管理员，只有他能开局 */
    secNew.appendChild(mk('h4', 'wz-sec-h', '管理员账号（建房的人就是管理员）'));
    var r5 = mk('div', 'wz-row');
    r5.appendChild(mk('label', '', '账号'));
    var au = mk('input', 'wz-input');
    au.id = 'wzNewAdminUser';
    au.type = 'text';
    au.maxLength = 20;
    au.autocomplete = 'off';
    au.placeholder = '3~20 位字母数字下划线';
    try { au.value = WZ.util.store.get(LAST_ADMIN_USER_KEY) || ''; } catch (e) { /* 忽略 */ }
    r5.appendChild(au);
    secNew.appendChild(r5);
    var r6 = mk('div', 'wz-row');
    r6.appendChild(mk('label', '', '密码'));
    var ap = mk('input', 'wz-input');
    ap.id = 'wzNewAdminPass';
    ap.type = 'password';
    ap.maxLength = 64;
    ap.autocomplete = 'new-password';
    ap.placeholder = '6~64 位，开局与暂停要用';
    ap.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') createRoom(); });
    r6.appendChild(ap);
    secNew.appendChild(r6);
    secNew.appendChild(mk('div', 'wz-hint',
      '建房后你就是管理员：等大家加入队伍，再由你点「开始 BP」——这就是「管理员开启房间之后才开始 BP」。'));

    var rowBtn = mk('div', 'wz-btn-row');
    var createBtn = mk('button', 'btn btn-primary', busy ? '正在建房…' : '创建并进入');
    createBtn.type = 'button';
    createBtn.id = 'wzCreateBtn';
    createBtn.disabled = !!busy;
    createBtn.addEventListener('click', createRoom);
    rowBtn.appendChild(createBtn);
    secNew.appendChild(rowBtn);
    s.appendChild(secNew);

    /* 房间列表 */
    var secList = mk('section', 'wz-sec');
    secList.appendChild(mk('h4', 'wz-sec-h', '房间列表'));
    if (lobbyError) secList.appendChild(mk('div', 'wz-err', lobbyError));
    if (!lobbyRooms) {
      secList.appendChild(mk('div', 'wz-hint', '正在读取房间列表…'));
      loadRooms();
    } else if (!lobbyRooms.length) {
      secList.appendChild(mk('div', 'wz-hint', '暂时没有房间，创建一个吧（房间会一直保留在服务器上）。'));
    } else {
      lobbyRooms.forEach(function (r) {
        var code = String((r && r.code) || '').toUpperCase();
        var item = mk('button', 'wz-room-item');
        item.type = 'button';
        var main = mk('span', 'ri-main');
        var nm = mk('span', 'ri-name', (r && r.name) || '未命名房间');
        var meta = mk('span', 'ri-meta',
          (MODE_NAME[r && r.mode] || r && r.mode || '排位征召') + ' · ' +
          (STATUS_NAME[r && r.status] || r && r.status || '等待中') + ' · ' +
          'BO' + ((r && r.seriesCount) || 1) + ' · ' +
          playersText(r) + ' 人');
        main.appendChild(nm);
        main.appendChild(meta);
        item.appendChild(main);
        item.appendChild(mk('span', 'ri-code', code));
        item.addEventListener('click', function () { joinRoom(code, 'auto'); });
        secList.appendChild(item);
      });
    }
    var refreshRow = mk('div', 'wz-btn-row');
    var rf = mk('button', 'btn btn-ghost', '刷新列表');
    rf.type = 'button';
    rf.addEventListener('click', function () { lobbyRooms = null; render(); });
    refreshRow.appendChild(rf);
    secList.appendChild(refreshRow);
    s.appendChild(secList);
  }

  /* 人数兼容三种形状（后端已确认：players 可能是人数，也可能带 playerCount / members） */
  function playersText(r) {
    if (!r) return '0';
    if (typeof r.players === 'number') return String(r.players);
    if (typeof r.playerCount === 'number') return String(r.playerCount);
    if (Array.isArray(r.players)) return String(r.players.length);
    if (Array.isArray(r.members)) return String(r.members.length);
    if (r.players && typeof r.players === 'object') return String(Object.keys(r.players).length);
    return '0';
  }

  function playerAt(s, side, slot) {
    var list = (s && s.players) || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && p.team === side && Number(p.slot) === Number(slot)) return p;
    }
    return null;
  }

  function isMe(s, p) {
    if (!p) return false;
    if (p.isMe === true) return true;
    var me = s && s.me;
    if (!me) return false;
    return String(me.nickname || '') === String(p.nickname || '') &&
      me.team === p.team && Number(me.slot) === Number(p.slot);
  }

  function seatEl(s, side, slot) {
    var p = playerAt(s, side, slot);
    var mine = isMe(s, p);
    var row = mk('button', 'wz-seat' + (p ? '' : ' empty') + (mine ? ' me' : ''));
    row.type = 'button';
    row.appendChild(mk('span', 'wz-seat-no', String(slot + 1)));
    if (p) {
      row.appendChild(mk('span', 'wz-seat-nm', p.nickname || '匿名'));
      var dot = mk('span', 'wz-dot' + (p.online === false ? ' off' : ''));
      dot.title = p.online === false ? '离线' : '在线';
      row.appendChild(dot);
      if (mine) row.appendChild(mk('span', 'wz-me', '我'));
      row.addEventListener('click', function () {
        if (mine) toast('这是你的位置', 'warn');
        else toast('该位置已被 ' + (p.nickname || '其他玩家') + ' 占用', 'warn');
      });
      row.title = (p.nickname || '') + ' · ' + (p.online === false ? '离线' : '在线');
    } else {
      row.appendChild(mk('span', 'wz-seat-nm empty', '空位 · 点击坐下'));
      row.title = '坐在' + sideLabel(side) + '第 ' + (slot + 1) + ' 位';
      row.addEventListener('click', function () { moveSeat(side, slot); });
    }
    return row;
  }

  function teamEl(s, side) {
    var box = mk('div', 'wz-team ' + side);
    var head = mk('div', 'wz-team-h');
    head.appendChild(mk('span', '', sideLabel(side)));
    var n = 0;
    for (var i = 0; i < 5; i++) if (playerAt(s, side, i)) n++;
    head.appendChild(mk('span', '', n + '/5'));
    box.appendChild(head);
    for (var j = 0; j < 5; j++) box.appendChild(seatEl(s, side, j));
    return box;
  }

  function renderRoom() {
    var s = dom.body;
    var st = lastState;

    if (!st || !st.room) {
      var secWait = mk('section', 'wz-sec');
      secWait.appendChild(mk('h4', 'wz-sec-h', '房间 ' + roomCode));
      secWait.appendChild(mk('div', 'wz-hint', '正在读取房间状态…'));
      var rw = mk('div', 'wz-btn-row');
      var rb = mk('button', 'btn btn-primary', '刷新');
      rb.type = 'button';
      rb.addEventListener('click', function () { loadState(); loadSeries(); });
      rw.appendChild(rb);
      secWait.appendChild(rw);
      s.appendChild(secWait);
      if (online) { loadState(); loadSeries(); }
      return;
    }

    var room = st.room || {};

    /* 每次重绘前用服务端值校准倒计时 */
    syncClock(st.game);

    /* ---------- ① 顶部状态条：现在到底在等什么，一眼看清 ---------- */
    var banner = mk('div', 'wz-banner');
    var launched = !!room.launched;
    var finished = room.status === 'finished';
    var gameNow = Number(room.currentGame || (st.series && st.series.gameNo) || 1);
    var boAll = Number(room.seriesCount || 1);
    if (finished) {
      banner.className = 'wz-banner done';
      banner.appendChild(mk('div', 'wz-banner-h', '系列赛已结束'));
      banner.appendChild(mk('div', 'wz-hint', 'BO' + boAll + ' 已打完，可以去「战绩」看回放。'));
    } else if (!launched) {
      banner.className = 'wz-banner wait';
      banner.appendChild(mk('div', 'wz-banner-h', '⏳ 等待管理员开始 BP'));
      var bp = st.players || [];
      var nb = 0, nr = 0;
      bp.forEach(function (p) { if (p.team === 'blue') nb++; else if (p.team === 'red') nr++; });
      banner.appendChild(mk('div', 'wz-hint',
        '先加入队伍（下面点空位坐下）：蓝方 ' + nb + ' 人 · 红方 ' + nr + ' 人　·　' +
        (MODE_NAME[room.mode] || room.mode) + ' · BO' + boAll +
        (room.turnSeconds ? ' · 每步 ' + room.turnSeconds + ' 秒' : ' · 不限时')));
      banner.appendChild(mk('div', 'wz-hint',
        isAdmin() ? '你是管理员，点下面那个大按钮就能开始。'
          : '等管理员点「开始 BP」。如果管理员就是你，请在下面登录。'));
    } else {
      banner.className = 'wz-banner live';
      banner.appendChild(mk('div', 'wz-banner-h', '● BP 进行中'));
      banner.appendChild(mk('div', 'wz-hint',
        '第 ' + gameNow + ' 局 / BO' + boAll + '　·　' + (MODE_NAME[room.mode] || room.mode) +
        (room.paused ? '　·　已暂停' : '')));
    }
    s.appendChild(banner);

    /* ---------- ② 房间号 + 邀请链接 ---------- */
    var secCode = mk('section', 'wz-sec');
    var box = mk('div', 'wz-code-box');
    var sub = mk('div', 'wz-code-sub');
    sub.appendChild(mk('div', 'wz-code', roomCode));
    sub.appendChild(mk('div', 'wz-hint', '把邀请链接发给队友，他们打开后点空位就能加入队伍'));
    box.appendChild(sub);
    secCode.appendChild(box);
    var rowCode = mk('div', 'wz-btn-row');
    var copyBtn = mk('button', 'btn btn-primary', '复制邀请链接');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', copyInvite);
    rowCode.appendChild(copyBtn);
    var reload = mk('button', 'btn btn-ghost', '刷新状态');
    reload.type = 'button';
    reload.addEventListener('click', function () { loadState(); loadSeries(); });
    rowCode.appendChild(reload);
    var leave = mk('button', 'btn btn-danger', '离开房间');
    leave.type = 'button';
    leave.addEventListener('click', leaveRoom);
    rowCode.appendChild(leave);
    secCode.appendChild(rowCode);
    s.appendChild(secCode);

    /* ---------- ③ 轮到谁 + 倒计时 ---------- */
    s.appendChild(turnSection(st, room));

    /* ---------- ④ 战队席位（先加入队伍） ---------- */
    var secSeats = mk('section', 'wz-sec');
    secSeats.appendChild(mk('h4', 'wz-sec-h',
      launched ? '战队席位' : '加入队伍（点空位坐下）'));
    var teams = mk('div', 'wz-teams');
    teams.appendChild(teamEl(st, 'blue'));
    teams.appendChild(teamEl(st, 'red'));
    secSeats.appendChild(teams);
    var memHint = mk('div', 'wz-hint',
      '在线 ' + onlineCount(st) + ' / ' + (((st.players || []).length) || 0) + ' 人' +
      ' · 绿点在线、灰点离线（离线席位不会被自动释放）');
    secSeats.appendChild(memHint);
    var me = st.me;
    if (!me) {
      var specRow = mk('div', 'wz-btn-row');
      ['blue', 'red'].forEach(function (side) {
        var b = mk('button', 'btn btn-ghost', '自动加入' + sideLabel(side));
        b.type = 'button';
        b.addEventListener('click', function () { joinRoom(roomCode, side); });
        specRow.appendChild(b);
      });
      var auto = mk('button', 'btn btn-primary', '随便给我个位置');
      auto.type = 'button';
      auto.addEventListener('click', function () { joinRoom(roomCode, 'auto'); });
      specRow.appendChild(auto);
      secSeats.appendChild(specRow);
      secSeats.appendChild(mk('div', 'wz-hint', '你还在旁观。点上面任一队的空位即可加入队伍。'));
    } else {
      var meLine = mk('div', 'wz-kv');
      var b1 = mk('span', '', '');
      b1.appendChild(document.createTextNode('我是 '));
      b1.appendChild(mk('b', '', me.nickname || WZ.net.myName()));
      b1.appendChild(document.createTextNode('　' + sideLabel(me.team) + ' ' + (Number(me.slot) + 1) + ' 号位'));
      meLine.appendChild(b1);
      secSeats.appendChild(meLine);
    }
    s.appendChild(secSeats);

    /* ---------- ⑤ 管理员区（登录 / 开始 BP / 暂停） ---------- */
    s.appendChild(adminSection(st, room));

    /* ---------- ⑥ 全局 BP 记录 ---------- */
    var gsec = globalSection(st, room);
    if (gsec) s.appendChild(gsec);

    /* ---------- ⑦ 系列赛控制台（仅管理员可操作） ---------- */
    var secSeries = mk('section', 'wz-sec' + (isAdmin() ? '' : ' wz-dim'));
    secSeries.appendChild(mk('h4', 'wz-sec-h', '系列赛控制台' + (isAdmin() ? '' : '（仅管理员）')));

    /* 每局胜负 */
    var winLine = mk('div', 'wz-hint');
    if (wins.length) {
      winLine.textContent = '每局战绩：' + wins.map(function (w) {
        return '第' + w.gameNo + '局 ' + (w.winner === 'blue' ? '蓝胜'
          : (w.winner === 'red' ? '红胜' : (w.status === 'done' ? '平/未记' : '进行中')));
      }).join(' · ');
    } else {
      winLine.textContent = '每局战绩：暂无记录';
    }
    secSeries.appendChild(winLine);

    var acts = st.actions || [];
    var totalSteps = ((st.series && st.series.order) || []).length;

    /* 控制按钮 */
    var rowCtrl = mk('div', 'wz-btn-row');
    var sel = mk('select', 'wz-select');
    sel.id = 'wzWinner';
    sel.style.flex = '0 0 108px';
    sel.disabled = !isAdmin();
    [['', '不记胜负'], ['blue', '蓝方胜'], ['red', '红方胜']].forEach(function (p) {
      var o = mk('option', '', p[1]);
      o.value = p[0];
      sel.appendChild(o);
    });
    rowCtrl.appendChild(sel);
    var nextBtn = mk('button', 'btn btn-primary', '下一局');
    nextBtn.type = 'button';
    nextBtn.disabled = !isAdmin() || finished;
    nextBtn.title = isAdmin() ? '结算本局并开下一局' : '只有管理员能换局';
    nextBtn.addEventListener('click', doNextGame);
    rowCtrl.appendChild(nextBtn);
    var undoBtn = mk('button', 'btn btn-warn', '撤销上一手');
    undoBtn.type = 'button';
    undoBtn.disabled = !isAdmin() || !acts.length;
    undoBtn.title = isAdmin() ? '撤销最后一手' : '只有管理员能撤销';
    undoBtn.addEventListener('click', doUndo);
    rowCtrl.appendChild(undoBtn);

    if (isAdmin()) {
      var pauseBtn = mk('button', 'btn btn-ghost', room.paused ? '继续计时' : '暂停计时');
      pauseBtn.type = 'button';
      pauseBtn.disabled = !launched || finished;
      pauseBtn.addEventListener('click', function () { doPause(!room.paused); });
      rowCtrl.appendChild(pauseBtn);

      var canShuffle = room.mode === 'random' && !acts.length && !finished;
      var shBtn = mk('button', 'btn btn-ghost', '重新随机顺序');
      shBtn.type = 'button';
      shBtn.disabled = !canShuffle;
      shBtn.title = canShuffle ? '重洗本局 ban/pick 顺序（仅本局未落任何一手时可用）'
        : (room.mode === 'random' ? '本局已经落子，不能重洗' : '仅「随机征召」模式可用');
      shBtn.addEventListener('click', doShuffle);
      rowCtrl.appendChild(shBtn);

      var finBtn = mk('button', 'btn btn-danger', '结束系列');
      finBtn.type = 'button';
      finBtn.disabled = finished;
      finBtn.addEventListener('click', doFinish);
      rowCtrl.appendChild(finBtn);
    }
    secSeries.appendChild(rowCtrl);
    if (!isAdmin()) {
      secSeries.appendChild(mk('div', 'wz-hint',
        '换局 / 撤销 / 结束系列都由管理员操作，避免大家同时点导致混乱。'));
    }
    s.appendChild(secSeries);

    /* 战绩入口：回放器已加载时给个直达链接（两个模块互相不硬依赖） */
    if (WZ.replayUI && typeof WZ.replayUI.open === 'function') {
      var secRp = mk('section', 'wz-sec');
      var goRp = mk('button', 'btn btn-ghost', '查看本房间战绩 / 回放');
      goRp.type = 'button';
      goRp.addEventListener('click', function () {
        panel.close();
        try { WZ.replayUI.open('room'); } catch (e) { console.error('[room] open replay failed', e); }
      });
      secRp.appendChild(goRp);
      s.appendChild(secRp);
    }
  }

  function onlineCount(s) {
    var list = (s && s.players) || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) if (!list[i] || list[i].online !== false) n++;
    return n;
  }

  /* ------------------------------------------------------------
     对外 API
     ------------------------------------------------------------ */

  panel.available = function () { return !!(WZ.net && WZ.net.isOnline && WZ.net.isOnline()); };

  panel.init = function (opts) {
    if (typeof opts === 'function') opts = { onState: opts };
    if (opts) setHandlers(opts);
    if (initialized) return panel;
    initialized = true;

    try { injectStyle(); } catch (e) { console.error('[room] style failed', e); }
    try {
      dom.btn = buildEntry();
      dom.drawer = buildDrawer();
      /* 关键：抽屉此时还没插进 document，document.getElementById 拿不到内部节点，
         必须从抽屉自身的子树里查（detached 树同样支持 querySelector） */
      dom.body = dom.drawer.querySelector('#wzRoomBody');
      dom.dot = dom.drawer.querySelector('#wzNetDot');
      dom.title = dom.drawer.querySelector('#wzRoomTitle');
      if (document.body) document.body.appendChild(dom.drawer);
      else document.addEventListener('DOMContentLoaded', function () {
        if (document.body) document.body.appendChild(dom.drawer);
      });
    } catch (e) {
      console.error('[room] init failed', e);
      return panel;
    }

    /* ?room=CODE：邀请链接带过来的房间号 */
    var invited = queryParam('room');
    if (invited) pendingCode = String(invited).trim().toUpperCase();

    var net = WZ.net;
    if (net && typeof net.onStatus === 'function') net.onStatus(onNetStatus);
    if (net && typeof net.init === 'function') {
      var p = net.init();
      if (p && typeof p.then === 'function') {
        p.then(function (st) { onNetStatus(st || (net.state ? net.state() : null)); },
          function () { onNetStatus({ online: false }); });
      }
    }
    onNetStatus(net && net.state ? net.state() : { online: false });
    return panel;
  };

  function onNetStatus(s) {
    var was = online;
    online = !!(s && s.online);
    if (dom.btn) dom.btn.hidden = !online && !roomCode;
    if (online && !was) {
      ensureSubscribed();
      /* 带 ?room=CODE 打开页面：若服务端认识我，就静默回到房间（不开抽屉、不打扰），
         非成员则只把邀请卡片备好，等用户自己点「加入」。 */
      if (pendingCode && !roomCode && WZ.net && typeof WZ.net.getState === 'function') {
        loadStateForInvite(pendingCode);
      }
      if (panel.isOpen()) { render(); if (roomCode) loadState(); }
    } else if (!online && was) {
      subscribedFor = '';
      if (panel.isOpen()) render();
    }
    updateHead();
    forward('onStatus', [s]);
  }

  panel.setHandlers = function (o) { setHandlers(o); return panel; };

  panel.open = function () {
    if (!dom.drawer) return false;
    dom.drawer.hidden = false;
    try { void dom.drawer.offsetWidth; } catch (e) { /* 忽略 */ }
    dom.drawer.classList.add('open');
    if (!online && WZ.net && typeof WZ.net.reprobe === 'function') {
      /* 上次探测失败过：用户主动打开时再试一次，成功即可用 */
      var st = WZ.net.state ? WZ.net.state() : null;
      if (!st || st.probed) WZ.net.reprobe().then(function () { render(); }, function () { render(); });
    }
    if (roomCode) { ensureSubscribed(); loadState(); loadSeries(); }
    else if (online) loadRooms();
    render();
    return true;
  };

  panel.close = function () {
    if (!dom.drawer) return false;
    dom.drawer.classList.remove('open');
    var d = dom.drawer;
    setTimeout(function () { if (!d.classList.contains('open')) d.hidden = true; }, 240);
    return true;
  };

  panel.toggle = function () { return panel.isOpen() ? (panel.close(), false) : panel.open(); };

  panel.isOpen = function () { return !!(dom.drawer && dom.drawer.classList.contains('open')); };

  /** 收到全量状态（SSE / REST）时调用；幂等，可重复喂同一份数据 */
  panel.applyState = function (s) {
    if (!s || typeof s !== 'object') return false;
    try {
      var c = s.room && s.room.code ? String(s.room.code).trim().toUpperCase() : '';
      if (c) roomCode = c;
      lastState = s;
    } catch (e) {
      console.error('[room] applyState failed', e);
      return false;
    }
    /* 订阅与渲染各自兜底：任何一边出问题都不能让「状态已经到手却不刷新」 */
    try { ensureSubscribed(); } catch (e) { console.error('[room] subscribe failed', e); }
    try {
      if (panel.isOpen()) render(); else updateHead();
    } catch (e) {
      console.error('[room] render failed', e);
    }
    forward('onState', [s]);
    return true;
  };

  panel.roomCode = function () { return roomCode; };
  panel.state = function () { return lastState; };
  panel.leave = leaveRoom;
  /* 从邀请链接（?room=CODE）或外部代码进入房间。
     设计：**不自动占座**，而是把邀请卡片显示出来，让用户自己点「加入」——
     避免点错链接就误占一个战队席位。这里只负责把卡片亮出来并补齐大厅数据。 */
  panel.enterRoom = function (code_) {
    var c = String(code_ || '').trim().toUpperCase();
    if (!c) return false;
    pendingCode = c;
    if (!panel.isOpen()) panel.open();
    if (roomCode === c) { loadState(); loadSeries(); }
    else if (online) { if (!lobbyRooms) loadRooms(); loadStateForInvite(c); }
    render();
    return true;
  };

  /* 邀请卡片要显示「这个房间现在什么情况」，所以先拉一次它的状态给卡片用。
     另外：如果服务端认识我的 playerKey（我已经在这个房间里 —— 例如刷新页面后
     再走一遍邀请链接，或先被别处 join 进来），这里直接采纳房间并订阅 SSE。
     否则页面会停在「加入」卡片上，主控拿不到 state，
     「未开局锁定 BP 面板」这类依赖 state 的逻辑就永远不会生效。 */
  function loadStateForInvite(c) {
    WZ.net.getState(c).then(function (s) {
      if (!s || !s.room || String(s.room.code).toUpperCase() !== c) { pendingInfo = null; return; }
      if (s.me) {
        pendingCode = '';
        pendingInfo = null;
        panel.applyState(s);        // 内部会 ensureSubscribed() 并转发 onState
        return;
      }
      pendingInfo = {
        name: s.room.name || '未命名房间',
        mode: s.room.mode, seriesCount: s.room.seriesCount,
        launched: !!s.room.launched,
        players: (s.players || []).length
      };
      render();
    }).catch(function () { pendingInfo = null; });
  }
  var pendingInfo = null;
  panel.refresh = function () {
    if (roomCode) { loadState(); loadSeries(); }
    lobbyRooms = null;
    if (!roomCode) loadRooms();
    render();
    return panel;
  };
  panel.loadRooms = loadRooms;
  panel.loadState = loadState;
  panel.inviteLink = inviteLink;

  /* 给接线方用的动作出口：联网模式下 BP 落子走这里（乐观更新 + 失败回滚由接线方做） */
  panel.sendAction = function (side, action, heroId) {
    if (!roomCode) {
      var e = WZ.net && WZ.net.err ? WZ.net.err('ERR_NO_ROOM', '还没有加入房间') : new Error('还没有加入房间');
      return Promise.reject(e);
    }
    return WZ.net.postAction(roomCode, { side: side, action: action, heroId: heroId });
  };

  panel.toast = toast;

  /* ---------- v3 新增导出 ---------- */
  panel.isAdmin = isAdmin;
  panel.adminLogin = doAdminLogin;
  panel.adminLogout = doAdminLogout;
  panel.launch = doLaunch;
  panel.pause = doPause;
  panel.launched = function () { return !!(lastState && lastState.room && lastState.room.launched); };
  panel.turn = function () {
    return { seconds: clock.seconds, remaining: clock.remain, paused: clock.paused, over: clock.over };
  };

  WZ.roomUI = panel;
})(window.WZ);
