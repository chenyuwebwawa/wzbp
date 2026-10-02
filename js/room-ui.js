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

  var MODES = [
    { id: 'ranked', name: '排位征召' },
    { id: 'kpl', name: 'KPL 全局 BP' },
    { id: 'peak', name: '巅峰赛' },
    { id: 'random', name: '随机征召' }
  ];
  var MODE_NAME = { ranked: '排位征召', kpl: 'KPL 全局 BP', peak: '巅峰赛', random: '随机征召' };
  var STATUS_NAME = { waiting: '等待中', drafting: 'BP 中', finished: '已结束' };

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
    '.wz-float-entry { position: fixed; right: 14px; bottom: 14px; z-index: 70; }'
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
    var nickEl = document.getElementById('wzNick');
    if (nickEl) WZ.net.setName(nickEl.value);
    busy = true;
    render();
    WZ.net.createRoom({
      name: nameEl ? nameEl.value : '',
      mode: modeEl ? modeEl.value : 'ranked',
      seriesCount: boEl ? Number(boEl.value) : 1,
      nickname: WZ.net.myName()
    }).then(function (res) {
      var code = res && res.room && res.room.code;
      if (!code) throw new Error('服务端没有返回房间号');
      roomCode = String(code).toUpperCase();
      pendingCode = '';
      toast('房间已创建：' + roomCode + '，正在自动占一个席位', 'ok', 3200);
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
     渲染
     ------------------------------------------------------------ */

  function render() {
    if (!dom.body) return;
    try {
      updateHead();
      dom.body.innerHTML = '';
      if (!online) renderOffline();
      else if (roomCode) renderRoom();
      else renderLobby();
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
      sub.appendChild(mk('div', 'wz-hint', '点右侧按钮即可入座（自动挑人少的一队）'));
      box.appendChild(sub);
      var go = mk('button', 'btn btn-primary', '加入');
      go.type = 'button';
      go.addEventListener('click', function () { joinRoom(pendingCode, 'auto'); });
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

    /* 房间号 + 邀请链接 */
    var secCode = mk('section', 'wz-sec');
    var box = mk('div', 'wz-code-box');
    var sub = mk('div', 'wz-code-sub');
    sub.appendChild(mk('div', 'wz-code', roomCode));
    sub.appendChild(mk('div', 'wz-hint',
      '房间号共 6 位（去掉易混字符），把邀请链接发给队友即可入座'));
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

    /* 我的身份 */
    var me = st.me;
    var secMe = mk('section', 'wz-sec');
    secMe.appendChild(mk('h4', 'wz-sec-h', '我的身份'));
    if (me) {
      var kvs = mk('div', 'wz-kv');
      secMe.appendChild(kvs);
      var b1 = mk('span', '', '');
      b1.appendChild(document.createTextNode('昵称 '));
      b1.appendChild(mk('b', '', me.nickname || WZ.net.myName()));
      kvs.appendChild(b1);
      var b2 = mk('span', '', '');
      b2.appendChild(document.createTextNode('位置 '));
      b2.appendChild(mk('b', '', sideLabel(me.team) + ' ' + (Number(me.slot) + 1) + ' 号位'));
      kvs.appendChild(b2);
    } else {
      secMe.appendChild(mk('div', 'wz-hint', '你还在旁观。点下面任一队的空位即可落座。'));
      var specRow = mk('div', 'wz-btn-row');
      ['blue', 'red'].forEach(function (side) {
        var b = mk('button', 'btn btn-ghost', '自动加入' + sideLabel(side));
        b.type = 'button';
        b.addEventListener('click', function () { joinRoom(roomCode, side); });
        specRow.appendChild(b);
      });
      var auto = mk('button', 'btn btn-primary', '自动入座');
      auto.type = 'button';
      auto.addEventListener('click', function () { joinRoom(roomCode, 'auto'); });
      specRow.appendChild(auto);
      secMe.appendChild(specRow);
    }
    s.appendChild(secMe);

    /* 席位 */
    var secSeats = mk('section', 'wz-sec');
    secSeats.appendChild(mk('h4', 'wz-sec-h', '战队席位（点空位坐下）'));
    var teams = mk('div', 'wz-teams');
    teams.appendChild(teamEl(st, 'blue'));
    teams.appendChild(teamEl(st, 'red'));
    secSeats.appendChild(teams);
    var memHint = mk('div', 'wz-hint',
      '在线 ' + onlineCount(st) + ' / ' + (((st.players || []).length) || 0) + ' 人' +
      ' · 绿点在线、灰点离线（离线席位不会被自动释放）');
    secSeats.appendChild(memHint);
    s.appendChild(secSeats);

    /* 系列赛控制台 */
    var secSeries = mk('section', 'wz-sec');
    secSeries.appendChild(mk('h4', 'wz-sec-h', '系列赛'));
    var gameNo = Number(room.currentGame || (st.series && st.series.gameNo) || 1);
    var bo = Number(room.seriesCount || 1);
    var kv = mk('div', 'wz-kv');
    var g1 = mk('span', '', '');
    g1.appendChild(document.createTextNode('当前 '));
    g1.appendChild(mk('b', '', '第 ' + gameNo + ' 局'));
    g1.appendChild(document.createTextNode(' / BO' + bo));
    kv.appendChild(g1);
    var st1 = mk('span', '', '');
    st1.appendChild(document.createTextNode('状态 '));
    st1.appendChild(mk('b', '', STATUS_NAME[room.status] || room.status || '-'));
    kv.appendChild(st1);
    if (room.mode === 'random') {
      var rm = mk('span', '', '');
      rm.appendChild(document.createTextNode('赛制 '));
      rm.appendChild(mk('b', '', '随机征召'));
      kv.appendChild(rm);
    }
    secSeries.appendChild(kv);

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

    /* 本局进度 */
    var acts = st.actions || [];
    var order = (st.series && st.series.order) || [];
    var totalSteps = order.length || (st.game && st.game.totalSteps) || 0;
    var prog = mk('div', 'wz-hint');
    var na = st.game && st.game.nextAction;
    var progText = '本局进度：已落 ' + acts.length + (totalSteps ? ' / ' + totalSteps : '') + ' 手';
    if (na) progText += ' · 轮到 ' + sideLabel(na.side) + actionLabel(na.action);
    else if (st.game && st.game.done) progText += ' · 本局 BP 已完成';
    prog.textContent = progText;
    secSeries.appendChild(prog);
    if (totalSteps) {
      var bar = mk('div', 'wz-progress');
      var fill = mk('i', '');
      fill.style.width = Math.min(100, Math.round(acts.length / totalSteps * 100)) + '%';
      bar.appendChild(fill);
      secSeries.appendChild(bar);
    }

    /* 控制按钮 */
    var rowCtrl = mk('div', 'wz-btn-row');
    var sel = mk('select', 'wz-select');
    sel.id = 'wzWinner';
    sel.style.flex = '0 0 108px';
    [['', '不记胜负'], ['blue', '蓝方胜'], ['red', '红方胜']].forEach(function (p) {
      var o = mk('option', '', p[1]);
      o.value = p[0];
      sel.appendChild(o);
    });
    rowCtrl.appendChild(sel);
    var nextBtn = mk('button', 'btn btn-primary', '下一局');
    nextBtn.type = 'button';
    nextBtn.disabled = room.status === 'finished';
    nextBtn.addEventListener('click', doNextGame);
    rowCtrl.appendChild(nextBtn);
    var undoBtn = mk('button', 'btn btn-warn', '撤销上一手');
    undoBtn.type = 'button';
    undoBtn.disabled = !acts.length;
    undoBtn.addEventListener('click', doUndo);
    rowCtrl.appendChild(undoBtn);

    var canShuffle = room.mode === 'random' && !acts.length && room.status !== 'finished';
    var shBtn = mk('button', 'btn btn-ghost', '重新随机顺序');
    shBtn.type = 'button';
    shBtn.disabled = !canShuffle;
    shBtn.title = canShuffle ? '重洗本局 ban/pick 顺序（仅本局未落任何一手时可用）'
      : (room.mode === 'random' ? '本局已经落子，不能重洗' : '仅「随机征召」模式可用');
    shBtn.addEventListener('click', doShuffle);
    rowCtrl.appendChild(shBtn);

    var finBtn = mk('button', 'btn btn-danger', '结束系列');
    finBtn.type = 'button';
    finBtn.disabled = room.status === 'finished';
    finBtn.addEventListener('click', doFinish);
    rowCtrl.appendChild(finBtn);
    secSeries.appendChild(rowCtrl);
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
  panel.enterRoom = function (code_) {
    var c = String(code_ || '').trim().toUpperCase();
    if (!c) return;
    pendingCode = c;
    if (!panel.isOpen()) panel.open(); else render();
  };
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

  WZ.roomUI = panel;
})(window.WZ);
