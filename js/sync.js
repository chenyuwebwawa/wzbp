/* ============================================================
   wzbp · 跨窗口同步
   ------------------------------------------------------------
   用途：直播时把「展示板」和「控制台」拆成两个窗口 —— 一个给 OBS
   采集，一个自己操作。

   为什么能通：file:// 下同一目录的页面属于同一 origin（实测 origin=file://），
   因此 BroadcastChannel 与 storage 事件都能跨窗口工作（已实测）。
   两条通道同时用：BroadcastChannel 负责即时投递，localStorage 负责
     ① 兜底（老浏览器没有 BroadcastChannel）
     ② 新窗口打开时取当前状态（storage 事件不会发给写入者自己）

   消息协议：
     { t: 'hello' }                    新窗口上线，请把当前状态发给我
     { t: 'snapshot', payload }        完整状态（回应 hello）
     { t: 'update', payload }          增量状态（每次 BP 变化 / 计时）
     { t: 'present', heroId, skinIndex }  展示窗自己切了皮肤/英雄，广播给控制窗
     { t: 'overlay', payload }         赛事面板（MVP 卡 / 赛前面板）数据 + 显示状态
     { t: 'tick', total, left }        倒计时读数
     { t: 'ping' } / { t: 'pong' }     检测是否已有别的窗口在跑

   角色（由 URL 决定，决定这个窗口是「发」还是「收」）：
     console —— 默认，主控制窗，负责广播
     display —— index.html?wzrole=display，BP 展示板采集窗
     overlay —— overlay.html?wzrole=overlay，赛事面板采集窗
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var CHANNEL = 'wzbp-sync-v1';
  var LS_KEY = 'wzbp.sync.v1';

  var sync = {};
  var ch = null;
  var handlers = [];
  var started = false;
  var role = 'console';

  /* 角色判定：不认识的取值一律当控制窗 */
  function detectRole() {
    var m = /[?&]wzrole=([a-z]+)/.exec(location.search || '');
    var v = m ? m[1] : '';
    if (v === 'display' || v === 'overlay') return v;
    return 'console';
  }

  sync.role = detectRole();
  sync.isDisplay = function () { return sync.role === 'display'; };
  sync.isOverlay = function () { return sync.role === 'overlay'; };
  sync.isConsole = function () { return sync.role === 'console'; };

  sync.start = function () {
    if (started) return;
    started = true;
    role = sync.role;

    try {
      ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = function (ev) { dispatch(ev.data); };
    } catch (e) { ch = null; }

    /* localStorage 兜底通道：storage 事件只在别的窗口写入时触发 */
    window.addEventListener('storage', function (ev) {
      if (ev.key !== LS_KEY || !ev.newValue) return;
      try { dispatch(JSON.parse(ev.newValue)); } catch (e) { /* 忽略坏数据 */ }
    });

    /* 展示窗上线，主动要一次当前状态（避免打开时是空白板） */
    if (role === 'display') {
      setTimeout(function () { sync.post({ t: 'hello' }); }, 120);
    }
  };

  function dispatch(msg) {
    if (!msg || typeof msg !== 'object' || !msg.t) return;
    handlers.forEach(function (fn) {
      try { fn(msg.t, msg); } catch (e) { console.error('[sync] handler error', e); }
    });
  }

  /* 对外发送：两条通道都走一遍 */
  sync.post = function (msg) {
    msg.from = role;
    msg.at = Date.now();
    if (ch) { try { ch.postMessage(msg); } catch (e) { /* 忽略 */ } }
    try { util.store.set(LS_KEY, JSON.stringify(msg)); } catch (e) { /* 忽略 */ }
  };

  /* 订阅：fn(type, msg) */
  sync.on = function (fn) {
    handlers.push(fn);
    return function () {
      var i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    };
  };

  /* 读出最近一次快照（新窗口启动时用，storage 事件收不到自己写的内容） */
  sync.lastSnapshot = function () {
    var raw = util.store.get(LS_KEY);
    if (!raw) return null;
    try {
      var m = JSON.parse(raw);
      return (m && (m.t === 'snapshot' || m.t === 'update')) ? m.payload : null;
    } catch (e) { return null; }
  };

  /* 心跳：用来判断是否已经有别的窗口在跑（避免重复开） */
  sync.ping = function () { sync.post({ t: 'ping' }); };

  WZ.sync = sync;
})(window.WZ);
