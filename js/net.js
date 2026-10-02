/* ============================================================
   wzbp · 网络层（身份 / 健康探测 / REST / SSE）
   ------------------------------------------------------------
   为什么这么写：
   · 契约 §0 实测：file:// 页面无法访问本机 http 服务（Chrome 一律拦截），
     所以探测失败必须「静默降级」——不抛异常、不弹窗，只让联网功能不可用。
     站点既是纯静态演示，也是联网对战台，两种形态共用一套代码。
   · 契约 §3 规定失败响应是 { ok:false, error, code }，这里统一映射成
     带 code + 中文 message 的 Error，UI 层只负责 toast 即可。
   · SSE 用 EventSource（自带断线重连）。重连成功后额外补一次 GET state：
     服务端本来就会补发（契约 §5），但半开连接 / 反代抽风时多一层保险。
   · 所有请求带超时：服务器挂掉时不能让界面无限转圈。
   导出面（契约 §8 与占位骨架约定）：
     init / isOnline / available / state / base / myKey / myName / setName /
     createRoom / joinRoom / leaveRoom / getState / listRooms / postAction /
     undo / nextGame / finishSeries / history / replay / recentGames /
     shuffle / subscribe / unsubscribe
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var LS_KEY = 'wzbp.player.key';
  var LS_NAME = 'wzbp.player.name';
  var DEFAULT_TIMEOUT = 8000;    // 普通请求
  var HEALTH_TIMEOUT = 3000;     // 探测要快，file:// 下别卡住启动
  var MAX_NAME = 20;             // 契约 §3.1：昵称 1..20 字符
  var HEARTBEAT_IDLE = 45000;    // 这么久没收到任何事件 → 主动重连
  var RETRY_MAX = 15000;         // 重连退避上限
  var REPROBE_GAP = 15000;       // 离线状态下自动重探的最小间隔

  var net = {};

  var state = {
    online: false,
    probed: false,       // 骨架里叫 checked，这里两个都留着
    reason: 'idle',      // idle | ok | file-protocol | ERR_*
    base: '',            // 默认同源（空串）；可用 ?api= 或 window.WZ_API_BASE 覆盖
    version: '',
    db: false,
    heroList: false,     // 服务端英雄白名单是否可用（契约 §7）
    heroListKnown: false,
    serverTime: '',
    lastError: null,
    since: 0,
    lastProbeAt: 0
  };

  var initPromise = null;
  var stream = null;              // 当前 SSE 订阅（同一时刻只保持一个房间）
  var statusListeners = [];

  /* ------------------------------------------------------------
     小工具（刻意不依赖 WZ.util 的加载顺序：net.js 可能先于 utils.js 加载）
     ------------------------------------------------------------ */

  function storeGet(k) {
    if (WZ.util && WZ.util.store) { try { return WZ.util.store.get(k); } catch (e) { /* 继续兜底 */ } }
    try { var v = window.localStorage.getItem(k); return v === null ? undefined : v; }
    catch (e) { return undefined; }
  }

  function storeSet(k, v) {
    if (WZ.util && WZ.util.store) { try { WZ.util.store.set(k, v); return; } catch (e) { /* 继续兜底 */ } }
    try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式等：丢了也无所谓 */ }
  }

  function queryParam(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(String(window.location.search || ''));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  function explicitBase() {
    var b = '';
    try {
      if (typeof window.WZ_API_BASE === 'string' && window.WZ_API_BASE) b = window.WZ_API_BASE;
    } catch (e) { /* 忽略 */ }
    if (!b) b = queryParam('api');
    return String(b).replace(/\/+$/, '');
  }

  function isFileProtocol() {
    try { return String(window.location.protocol) === 'file:'; } catch (e) { return false; }
  }

  /* UUID：crypto.randomUUID 首选；老浏览器/非安全上下文逐级降级 */
  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (e) { /* 降级 */ }
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        var b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;         // version 4
        b[8] = (b[8] & 0x3f) | 0x80;         // variant 10
        var hex = [];
        for (var i = 0; i < 16; i++) hex.push((b[i] + 0x100).toString(16).slice(1));
        return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
          hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
      }
    } catch (e) { /* 再降级 */ }
    /* 最后兜底：file:// 或老浏览器下 crypto 可能整个不可用 */
    return 'p-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }

  /* 昵称清洗：契约 §3.1 —— 去首尾空白，1..20 字符，空则「玩家+4位随机」 */
  function cleanName(n) {
    var v = String(n === undefined || n === null ? '' : n).replace(/\s+/g, ' ').trim();
    if (!v) v = defaultName();
    if (v.length > MAX_NAME) v = v.slice(0, MAX_NAME);
    return v;
  }

  function defaultName() {
    /* 从 playerKey 派生 4 位数字：同一台机器每次进来名字一致，队友好认人 */
    var k = storeGet(LS_KEY) || uuid();
    var h = 0;
    for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) % 100000;
    return '玩家' + ('0000' + (h % 10000)).slice(-4);
  }

  /* ------------------------------------------------------------
     身份
     ------------------------------------------------------------ */

  net.myKey = function () {
    var k = storeGet(LS_KEY);
    if (!k) { k = uuid(); storeSet(LS_KEY, k); }
    return String(k);
  };

  net.myName = function () {
    var n = storeGet(LS_NAME);
    if (!n) { n = defaultName(); storeSet(LS_NAME, n); }
    return cleanName(n);
  };

  net.setName = function (n) {
    var v = cleanName(n);
    storeSet(LS_NAME, v);
    return v;
  };

  net.player = function () { return { key: net.myKey(), name: net.myName() }; };

  /* ------------------------------------------------------------
     状态 / 状态订阅
     ------------------------------------------------------------ */

  net.state = function () {
    return {
      online: !!state.online,
      checked: !!state.probed,        // 兼容占位骨架的字段名
      probed: !!state.probed,
      reason: state.reason,
      base: state.base,
      version: state.version,
      db: !!state.db,
      heroList: !!state.heroList,
      heroListKnown: !!state.heroListKnown,
      serverTime: state.serverTime,
      connection: net.connection(),
      lastError: state.lastError
    };
  };

  net.isOnline = function () { return !!state.online; };
  net.available = function () { return !!state.online; };   // 骨架里的别名
  net.base = function () { return state.base; };

  /* 订阅状态变化（联网/离线、SSE 连接状态），返回取消函数 */
  net.onStatus = function (fn) {
    if (typeof fn !== 'function') return function () {};
    statusListeners.push(fn);
    return function () {
      var i = statusListeners.indexOf(fn);
      if (i >= 0) statusListeners.splice(i, 1);
    };
  };

  function emitStatus() {
    var s = net.state();
    statusListeners.slice().forEach(function (fn) {
      try { fn(s); } catch (e) { console.error('[net] status listener error', e); }
    });
  }

  net.describe = function (err) {
    if (!err) return '未知错误';
    if (err.message) return String(err.message);
    return String(err);
  };

  function netErr(code, message, status, detail) {
    var e = new Error(message);
    e.code = code;
    e.status = status || 0;
    e.detail = detail || null;
    e.wzbp = true;                 // 标记成「我们造的错」，便于上层区分
    return e;
  }
  net.err = netErr;

  /* ------------------------------------------------------------
     REST
     ------------------------------------------------------------ */

  function buildUrl(path) {
    if (/^https?:/i.test(path)) return path;
    return state.base + (path.charAt(0) === '/' ? path : '/' + path);
  }

  /* 服务端返回的 { ok:false, error, code } → Error */
  function fromServer(data, status) {
    return netErr(
      (data && data.code) || ('ERR_HTTP_' + status),
      (data && data.error) || ('请求失败（HTTP ' + status + '）'),
      status,
      data
    );
  }

  /**
   * 唯一的底层请求出口。
   * @param {string} method GET/POST...
   * @param {string} path   /api/... 或绝对地址
   * @param {object} [body] 会被 JSON 序列化
   * @param {object} [opts] { timeout, force }
   *   force=true 时即使处于离线态也真的发请求（用于 /api/health 探测）
   * @returns {Promise<object>} 成功 resolve 服务端 JSON，失败 reject 带 code 的 Error
   */
  function request(method, path, body, opts) {
    opts = opts || {};
    var timeout = opts.timeout || DEFAULT_TIMEOUT;

    return new Promise(function (resolve, reject) {
      /* 离线态直接短路：不产生无意义的网络错误与控制台噪音 */
      if (!state.online && !opts.force) {
        reject(netErr('ERR_OFFLINE', '未连接服务器（当前为纯静态模式）'));
        return;
      }
      if (typeof window.XMLHttpRequest !== 'function') {
        reject(netErr('ERR_NO_XHR', '浏览器不支持 XMLHttpRequest'));
        return;
      }

      var xhr;
      try { xhr = new window.XMLHttpRequest(); }
      catch (e) { reject(netErr('ERR_NO_XHR', '无法创建请求对象')); return; }

      var url;
      try { url = buildUrl(path); }
      catch (e) { reject(netErr('ERR_BAD_URL', '请求地址不合法：' + path)); return; }

      var settled = false;
      function done(fn, arg) { if (settled) return; settled = true; fn(arg); }

      try {
        xhr.open(method, url, true);
      } catch (e) {
        /* file:// 下 Chrome 可能在 open() 就抛 SecurityError */
        done(reject, netErr('ERR_NETWORK', '无法发起请求：请通过 http(s) 打开本页（file:// 下浏览器禁止联网）'));
        return;
      }

      xhr.timeout = timeout;
      try {
        xhr.setRequestHeader('Accept', 'application/json');
        if (body !== undefined && body !== null) {
          xhr.setRequestHeader('Content-Type', 'application/json;charset=utf-8');
        }
        /* 契约 §1：写操作带 playerKey，header 与 body 皆可，服务端先看 header */
        xhr.setRequestHeader('X-Player-Key', net.myKey());
      } catch (e) { /* 个别环境 header 只读：忽略 */ }

      xhr.onload = function () {
        var status = xhr.status;
        var text = '';
        try { text = xhr.responseText || ''; } catch (e) { text = ''; }
        var data = null, badJson = false;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { badJson = true; }
        }

        if (status >= 200 && status < 300) {
          if (data && data.ok === false) { done(reject, fromServer(data, status)); return; }
          if (badJson) {
            done(reject, netErr('ERR_BAD_JSON', '服务端返回的不是 JSON（HTTP ' + status + '）', status, text.slice(0, 200)));
            return;
          }
          done(resolve, data === null ? {} : data);
          return;
        }
        /* 4xx / 5xx：优先用服务端给的中文原因（契约 §3） */
        if (data && (data.error || data.code)) { done(reject, fromServer(data, status)); return; }
        if (status >= 500) {
          done(reject, netErr('ERR_SERVER', '服务端错误（HTTP ' + status + '）', status, text.slice(0, 200)));
        } else if (status >= 400) {
          done(reject, netErr('ERR_HTTP', '请求被拒绝（HTTP ' + status + '）', status, text.slice(0, 200)));
        } else {
          done(reject, netErr('ERR_NETWORK', '网络不可达：请确认已通过 http(s) 打开页面，且服务端已启动', status, text.slice(0, 200)));
        }
      };

      xhr.ontimeout = function () {
        done(reject, netErr('ERR_TIMEOUT', '请求超时（' + Math.round(timeout / 1000) + ' 秒）：服务器无响应'));
      };
      xhr.onerror = function () {
        done(reject, netErr('ERR_NETWORK', '网络不可达：请确认已通过 http(s) 打开页面，且服务端已启动'));
      };
      xhr.onabort = function () {
        done(reject, netErr('ERR_ABORT', '请求已取消'));
      };

      try { xhr.send(body === undefined || body === null ? null : JSON.stringify(body)); }
      catch (e) {
        done(reject, netErr('ERR_NETWORK', '请求发送失败：' + (e && e.message ? e.message : e)));
      }
    });
  }

  net.request = request;           // 给接线留的口子：契约之外的接口也能直接用

  /* 房间号统一大写（契约 §3.1 生成的字符集就是大写） */
  function code(code_) { return encodeURIComponent(String(code_ || '').trim().toUpperCase()); }

  net.health = function (opts) {
    return request('GET', '/api/health', null, { force: true, timeout: (opts && opts.timeout) || HEALTH_TIMEOUT });
  };

  net.createRoom = function (o) {
    o = o || {};
    return request('POST', '/api/rooms', {
      name: String(o.name || ''),
      mode: o.mode || 'ranked',
      seriesCount: Number(o.seriesCount || 1),
      nickname: cleanName(o.nickname || net.myName()),
      playerKey: net.myKey()
    });
  };

  net.listRooms = function () {
    return request('GET', '/api/rooms').then(function (d) { return (d && d.rooms) || []; });
  };

  net.joinRoom = function (room, o) {
    o = o || {};
    var body = {
      nickname: cleanName(o.nickname || net.myName()),
      playerKey: net.myKey(),
      team: o.team || 'auto'
    };
    if (o.slot !== undefined && o.slot !== null) body.slot = Number(o.slot);
    return request('POST', '/api/rooms/' + code(room) + '/join', body);
  };

  net.leaveRoom = function (room) {
    return request('POST', '/api/rooms/' + code(room) + '/leave', { playerKey: net.myKey() });
  };

  net.getState = function (room) {
    /* GET 类接口也带上 playerKey：state 是按连接个性化的（me / isMe），
       后端同时支持 X-Player-Key 头与 ?playerKey=，两条路都走通最稳 */
    return request('GET', '/api/rooms/' + code(room) + '/state?playerKey=' + encodeURIComponent(net.myKey()));
  };

  net.postAction = function (room, o) {
    o = o || {};
    return request('POST', '/api/rooms/' + code(room) + '/action', {
      playerKey: net.myKey(),
      side: o.side,
      action: o.action,
      heroId: o.heroId
    });
  };

  net.undo = function (room) {
    return request('POST', '/api/rooms/' + code(room) + '/undo', { playerKey: net.myKey() });
  };

  net.nextGame = function (room, o) {
    o = o || {};
    var body = { playerKey: net.myKey() };
    if (o.winner) body.winner = o.winner;
    return request('POST', '/api/rooms/' + code(room) + '/next-game', body);
  };

  net.finishSeries = function (room) {
    return request('POST', '/api/rooms/' + code(room) + '/finish', { playerKey: net.myKey() });
  };

  net.shuffle = function (room) {
    return request('POST', '/api/rooms/' + code(room) + '/shuffle', { playerKey: net.myKey() });
  };

  net.history = function (room) {
    return request('GET', '/api/rooms/' + code(room) + '/history?playerKey=' + encodeURIComponent(net.myKey()))
      .then(function (d) {
        return (d && d.games) || [];
      });
  };

  net.replay = function (gameId) {
    return request('GET', '/api/games/' + encodeURIComponent(String(gameId)) + '/replay');
  };

  net.recentGames = function () {
    return request('GET', '/api/games/recent').then(function (d) { return (d && d.games) || []; });
  };

  /* ------------------------------------------------------------
     SSE（契约 §5）
     ------------------------------------------------------------ */

  function emit(fn, args) {
    if (typeof fn !== 'function') return;
    try { fn.apply(null, args || []); }
    catch (e) { console.error('[net] stream handler error', e); }
  }

  net.isStreamSupported = function () { return typeof window.EventSource === 'function'; };
  net.connection = function () { return stream ? stream.conn : 'idle'; };
  net.streamCode = function () { return stream ? stream.code : null; };

  function streamUrl(c) {
    return buildUrl('/api/stream') +
      '?code=' + encodeURIComponent(c) +
      '&playerKey=' + encodeURIComponent(net.myKey());
  }

  function stopWatchdog() {
    if (stream && stream.beat) { clearInterval(stream.beat); stream.beat = null; }
  }

  function stopRetryTimer() {
    if (stream && stream.timer) { clearTimeout(stream.timer); stream.timer = null; }
  }

  function closeEs() {
    if (!stream || !stream.es) return;
    try { stream.es.close(); } catch (e) { /* 忽略 */ }
    stream.es = null;
  }

  function scheduleRetry() {
    if (!stream || stream.closed) return;
    if (stream.timer) return;
    var n = (stream.retry = (stream.retry || 0) + 1);
    /* 指数退避：0.8s → 1.6s → 3.2s … 最多 15s */
    var delay = Math.min(RETRY_MAX, Math.round(800 * Math.pow(2, Math.min(n - 1, 5))));
    stream.timer = setTimeout(function () {
      if (!stream || stream.closed) return;
      stream.timer = null;
      openStream();
    }, delay);
  }

  /* 重连/首连后补一次全量状态：SSE 可能刚好处在断档期，
     服务端虽会补发，但不能把界面正确性押在网络上 */
  function resync(s) {
    var seq = s.seq;
    net.getState(s.code).then(function (data) {
      if (!stream || stream !== s || s.closed) return;
      if (s.seq !== seq) return;                  // 期间 SSE 已推来更新的状态，丢弃这次
      if (data && data.room) { s.seq++; emit(s.handlers.onState, [data]); }
    }, function () { /* 补发失败不致命：SSE 仍在，后续推送会到 */ });
  }

  function onStreamEvent(s, name, ev) {
    s.lastEventAt = Date.now();
    var data = null;
    try { data = ev && ev.data ? JSON.parse(ev.data) : null; } catch (e) { data = null; }
    if (name === 'ping') return;
    if (name === 'hello') { emit(s.handlers.onHello, [data || {}]); return; }
    if (name === 'state') { s.seq++; emit(s.handlers.onState, [data]); return; }
    if (name === 'action') {
      emit(s.handlers.onAction, [data && data.action ? data.action : data, data && data.game]);
      return;
    }
    if (name === 'presence') {
      emit(s.handlers.onPresence, [data && data.players ? data.players : data]);
      return;
    }
    if (name === 'game') {
      emit(s.handlers.onGame, [data && data.game ? data.game : data]);
      return;
    }
  }

  function openStream() {
    var s = stream;
    if (!s || s.closed) return;
    if (typeof window.EventSource !== 'function') {
      s.conn = 'unsupported';
      emitStatus();
      return;
    }

    closeEs();
    var es;
    try { es = new window.EventSource(streamUrl(s.code)); }
    catch (e) {
      s.conn = 'reconnecting';
      emitStatus();
      scheduleRetry();
      return;
    }
    s.es = es;
    s.conn = s.retry ? 'reconnecting' : 'connecting';
    emitStatus();

    es.onopen = function () {
      if (!stream || stream !== s || s.closed) return;
      var reconnected = !!s.everOpen;
      s.retry = 0;
      s.hadError = false;
      s.everOpen = true;
      s.conn = 'open';
      s.lastEventAt = Date.now();
      emitStatus();
      emit(s.handlers.onOpen, [{ reconnected: reconnected, code: s.code }]);
      resync(s);
    };

    es.onerror = function () {
      if (!stream || stream !== s || s.closed) return;
      s.hadError = true;
      s.conn = 'reconnecting';
      emitStatus();
      emit(s.handlers.onError, [netErr('ERR_STREAM', es.readyState === 2
        ? '实时连接已断开，正在重连…' : '实时连接不稳定，正在自动重连…')]);
      /* EventSource 会自己重连；只有它彻底放弃（readyState=CLOSED）时才由我们兜底 */
      if (es.readyState === 2) {
        closeEs();
        scheduleRetry();
      }
    };

    ['hello', 'state', 'action', 'presence', 'game', 'ping'].forEach(function (name) {
      es.addEventListener(name, function (ev) {
        if (!stream || stream !== s || s.closed) return;
        onStreamEvent(s, name, ev);
      });
    });

    /* 半开连接（拔网线、代理静默丢包）不会触发 onerror，靠心跳超时兜底：
       契约 §5 每 20 秒一个 ping，这里 45 秒没任何事件就主动重连 */
    stopWatchdog();
    s.beat = setInterval(function () {
      if (!stream || stream !== s || s.closed) { stopWatchdog(); return; }
      if (Date.now() - (s.lastEventAt || 0) > HEARTBEAT_IDLE) {
        s.conn = 'reconnecting';
        emitStatus();
        closeEs();
        s.retry = (s.retry || 0) + 1;
        scheduleRetry();
      }
    }, 15000);
  }

  /**
   * 订阅某房间的 SSE。同一时刻只保持一个订阅（换房间自动退订旧的）。
   * @param {string} room 房间号
   * @param {object} handlers { onState, onAction, onPresence, onGame, onOpen, onError, onHello }
   * @returns {object|null} 成功返回 { ok, code, close(), unsubscribe() }，离线/不支持返回 null
   */
  net.subscribe = function (room, handlers) {
    net.unsubscribe();
    var c = String(room || '').trim().toUpperCase();
    if (!c) return null;
    /* 离线时静默失败：调用方（room-ui）会用「重试连接」入口补偿 */
    if (!state.online) return null;
    if (typeof window.EventSource !== 'function') return null;

    stream = {
      code: c,
      handlers: handlers || {},
      es: null,
      conn: 'connecting',
      retry: 0,
      seq: 0,
      everOpen: false,
      hadError: false,
      lastEventAt: Date.now(),
      timer: null,
      beat: null,
      closed: false
    };
    openStream();
    return { ok: true, code: c, close: net.unsubscribe, unsubscribe: net.unsubscribe };
  };

  net.unsubscribe = function () {
    if (!stream) return;
    stream.closed = true;
    stopRetryTimer();
    stopWatchdog();
    closeEs();
    stream = null;
    emitStatus();
  };

  /* ------------------------------------------------------------
     探测 / 初始化
     ------------------------------------------------------------ */

  function markOffline(reason, err) {
    state.online = false;
    state.reason = reason || 'ERR_NETWORK';
    state.lastError = err || null;
    state.db = false;
    state.heroList = false;
    state.heroListKnown = false;
    /* 掉线时结束实时订阅：避免对着空气重连 */
    if (stream) net.unsubscribe();
    emitStatus();
  }

  function markOnline(data) {
    state.online = true;
    state.reason = 'ok';
    state.version = (data && data.version) || '';
    state.db = !!(data && data.db);
    state.heroListKnown = !!(data && typeof data.heroList === 'boolean');
    state.heroList = state.heroListKnown ? !!data.heroList : false;
    state.serverTime = (data && data.time) || '';
    state.since = Date.now();
    state.lastError = null;
    emitStatus();
  }

  /**
   * 探测 /api/health（契约 §3）。
   * file:// 下直接跳过网络请求，静默进入纯静态模式。
   * 永不 reject：resolve { online, ... } 状态快照。
   */
  net.init = function (opts) {
    opts = opts || {};
    state.base = explicitBase();

    if (initPromise && !opts.force) return initPromise;   // 幂等：多次调用只探一次

    state.probed = true;
    state.lastProbeAt = Date.now();

    if (isFileProtocol() && !state.base) {
      markOffline('file-protocol', netErr('ERR_OFFLINE', 'file:// 下浏览器禁止访问本机服务，已进入纯静态模式'));
      initPromise = Promise.resolve(net.state());
      return initPromise;
    }

    initPromise = request('GET', '/api/health', null, {
      force: true,
      timeout: opts.timeout || HEALTH_TIMEOUT
    }).then(function (data) {
      markOnline(data);
      return net.state();
    }, function (err) {
      markOffline(err && err.code ? err.code : 'ERR_NETWORK', err);
      initPromise = null;               // 允许后续 reprobe 重新探测
      return net.state();               // 关键：不 reject、不弹窗
    });
    return initPromise;
  };

  net.reprobe = function () { return net.init({ force: true }); };

  /* 自动恢复：网络恢复 / 切回前台时，若仍离线就（限流地）重探一次 */
  try {
    window.addEventListener('online', function () {
      if (!state.online) net.reprobe();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (state.online || !state.probed) return;
      if (Date.now() - state.lastProbeAt < REPROBE_GAP) return;
      net.reprobe();
    });
  } catch (e) { /* 非浏览器环境：忽略 */ }

  WZ.net = net;
})(window.WZ);
