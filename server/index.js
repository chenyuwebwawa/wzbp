/* ============================================================
   wzbp · 服务入口（契约 §9）
   ------------------------------------------------------------
   · HTTP 路由分发：/api/* → api.js，其余 → 静态文件（项目根目录）
   · 静态文件：MIME、index.html 兜底、路径穿越防护、HEAD
   · SSE 注册表：hello / state / action / presence / game / ping
     每 20 秒 ping，30 秒无心跳清理连接（契约 §5）
   · **只监听 127.0.0.1**（由宝塔 nginx 反代）

   启动：node server/index.js      （或 npm start / npm run dev）
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const db = require('./db');
const heroes = require('./heroes');
const api = require('./api');

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendText(res, status, text, type) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': (type || 'text/plain') + '; charset=utf-8',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sendFile(req, res, full, status) {
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (e) {
    return false;
  }
  if (!stat.isFile()) return false;

  const headers = {
    'Content-Type': mimeOf(full),
    'Content-Length': stat.size,
    'Last-Modified': stat.mtime.toUTCString(),
    /* 页面/脚本改动后刷新即生效，避免部署后还看到旧版本 */
    'Cache-Control': 'no-cache, must-revalidate'
  };
  if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
    res.writeHead(status || 200, headers);
    res.end();
    return true;
  }
  res.writeHead(status || 200, headers);
  const stream = fs.createReadStream(full);
  stream.on('error', function () {
    try { res.destroy(); } catch (e) { /* 忽略 */ }
  });
  stream.pipe(res);
  return true;
}

function serveStatic(req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return sendText(res, 405, '方法不允许', 'text/plain');
  }

  let decoded = '';
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch (e) {
    return sendText(res, 400, '路径编码不合法');
  }

  /* 路径穿越防护（第一层：显式拒绝 .. 片段与空字节） */
  if (decoded.indexOf('\0') >= 0 || /(^|[\\/])\.\.([\\/]|$)/.test(decoded)) {
    return sendText(res, 403, '禁止访问');
  }

  let rel = decoded.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  /* 路径穿越防护（第二层：解析后必须仍在项目根目录内） */
  const full = path.resolve(config.root, rel);
  if (full !== config.root && !full.startsWith(config.root + path.sep)) {
    return sendText(res, 403, '禁止访问');
  }

  /* 目录 → 目录下的 index.html */
  let target = full;
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) target = path.join(full, 'index.html');
  } catch (e) { /* 不存在：走下面的兜底 */ }

  if (sendFile(req, res, target, 200)) return;

  /* index.html 兜底：没有扩展名的未知路径一律交给首页处理（前端路由/短链） */
  const hasExt = path.extname(rel) !== '';
  if (!hasExt) {
    const fallback = path.join(config.root, 'index.html');
    if (sendFile(req, res, fallback, 200)) return;
  }
  return sendText(res, 404, '404 页面不存在：/' + rel);
}

/* ---------------- SSE 注册表（契约 §5） ---------------- */

const clients = new Set();
let clientSeq = 0;
let pingTimer = null;
let sweepTimer = null;

function writeRaw(client, text) {
  if (client.res.writableEnded || client.res.destroyed) return false;
  try {
    return client.res.write(text);
  } catch (e) {
    return false;
  }
}

function eventText(event, data) {
  return 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data === undefined ? {} : data) + '\n\n';
}

function dropClient(client) {
  if (!client || client.closed) return;
  client.closed = true;
  clients.delete(client);
  keysOf(client.code).delete(client.playerKey);
  api.notifyPresence(client.code);
}

function keysOf(code) {
  let set = null;
  for (const c of clients) {
    if (c.code !== code) continue;
    if (!set) set = new Set();
    if (c.playerKey) set.add(c.playerKey);
  }
  return set || new Set();
}

function openStream(req, res, meta) {
  const client = {
    id: ++clientSeq,
    res,
    code: meta.code,
    playerKey: meta.playerKey || '',
    /* v3：SSE 也认管理员令牌，这样 state.admin.you 能按连接个性化 */
    adminToken: meta.adminToken || '',
    lastBeat: Date.now(),
    stalledSince: 0,
    closed: false
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'      // 宝塔 nginx：关掉反代缓冲，SSE 才能实时
  });
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
    res.socket.setKeepAlive(true);
  }
  clients.add(client);

  /* 契约 §5：连接建立先发 hello，随后 api 会立刻补一条 state */
  writeRaw(client, eventText('hello', { serverTime: new Date().toISOString() }));

  const onGone = function () {
    dropClient(client);
  };
  req.on('close', onGone);
  req.on('error', onGone);
  res.on('error', onGone);

  return client;
}

function sendEvent(client, event, data) {
  if (!client || client.closed) return false;
  const ok = writeRaw(client, eventText(event, data));
  if (ok) {
    client.lastBeat = Date.now();
    client.stalledSince = 0;
  } else if (!client.stalledSince) {
    client.stalledSince = Date.now();
  }
  return ok;
}

/* 广播：payload 可以是对象，也可以是 (client) => 对象（用于个性化 me/isMe） */
function broadcast(code, event, payload) {
  for (const client of Array.from(clients)) {
    if (client.code !== code) continue;
    let data = payload;
    if (typeof payload === 'function') {
      try {
        data = payload(client);
      } catch (e) {
        console.error('[sse] payload 生成失败：', e && e.message);
        continue;
      }
    }
    sendEvent(client, event, data);
  }
}

function pingAll() {
  const body = ': ka\n\n' + eventText('ping', {});
  for (const client of Array.from(clients)) {
    if (client.res.writableEnded || client.res.destroyed) { dropClient(client); continue; }
    let ok = false;
    try {
      ok = client.res.write(body);
    } catch (e) {
      ok = false;
    }
    if (ok) {
      client.lastBeat = Date.now();
      client.stalledSince = 0;
    } else if (!client.stalledSince) {
      /* 写不动了：进入观察期，30 秒内还没恢复就判定为死连接 */
      client.stalledSince = Date.now();
    }
  }
}

function sweepStale() {
  const now = Date.now();
  for (const client of Array.from(clients)) {
    if (client.res.writableEnded || client.res.destroyed) { dropClient(client); continue; }
    if (client.stalledSince && now - client.stalledSince > config.sse.staleMs) {
      console.warn('[sse] 清理无心跳连接：room=' + client.code + ' id=' + client.id);
      try { client.res.destroy(); } catch (e) { /* 忽略 */ }
      dropClient(client);
    }
  }
}

function closeAllStreams() {
  for (const client of Array.from(clients)) {
    try { client.res.end(); } catch (e) { /* 忽略 */ }
    dropClient(client);
  }
}

const sse = {
  open: openStream,
  send: sendEvent,
  broadcast,
  onlineKeys: keysOf,
  count() { return clients.size; },
  closeAll: closeAllStreams
};

api.attach({ sse });

/* ---------------- HTTP 服务 ---------------- */

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Player-Key, X-Admin-Token',
    'Vary': 'Origin'
  };
}

const server = http.createServer(function (req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || config.host + ':' + config.port));
  } catch (e) {
    return sendText(res, 400, '请求地址不合法');
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const cors = corsHeaders(req);
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    api.handle(req, res, url).catch(function (e) {
      console.error('[http] /api 处理异常：', e && e.stack ? e.stack : e);
      if (!res.headersSent) sendText(res, 500, '服务端内部错误');
      else { try { res.end(); } catch (e2) { /* 忽略 */ } }
    });
    return;
  }

  serveStatic(req, res, url);
});

server.on('clientError', function (err, socket) {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* 忽略 */ }
});

function shutdown(signal) {
  console.log('\n[server] 收到 ' + signal + '，正在关闭…');
  if (pingTimer) clearInterval(pingTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  closeAllStreams();
  server.close(function () {
    db.close().then(function () {
      console.log('[server] 已关闭');
      process.exit(0);
    }).catch(function () { process.exit(0); });
  });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('uncaughtException', function (e) {
  console.error('[server] 未捕获异常：', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', function (e) {
  console.error('[server] 未处理的 Promise 拒绝：', e && e.stack ? e.stack : e);
});

/* ---------------- 启动 ---------------- */

async function main() {
  const desc = config.describe();
  console.log('wzbp · 王者荣耀 BP 展示台 —— 后端服务');
  console.log('  监听地址：http://' + desc.listen + '（只监听本机，由宝塔 nginx 反代 /api/ 与 /api/stream）');
  console.log('  静态根目录：' + desc.root);
  console.log('  数据库：' + desc.db);

  await db.init();

  console.log('  英雄白名单：' + (heroes.ok
    ? '已加载 ' + heroes.count + ' 个英雄（' + path.relative(desc.root, heroes.HERO_FILE) + '）'
    : '未加载，降级为不校验英雄存在性 —— ' + heroes.note));

  await new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  }).catch(function (e) {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[server] 端口 ' + config.port + ' 已被占用。');
      console.error('[server] 换个端口：WZBP_PORT=8788 npm start；或先结束旧进程。');
    } else {
      console.error('[server] 监听失败：', e && e.message);
    }
    process.exit(1);
  });

  console.log('  就绪：数据库 ' + (await db.isHealthy() ? '正常' : '异常') +
    '，等待 /api/health 探活');
  console.log('');

  pingTimer = setInterval(pingAll, config.sse.pingMs);
  sweepTimer = setInterval(sweepStale, config.sse.sweepMs);
  if (pingTimer.unref) pingTimer.unref();
  if (sweepTimer.unref) sweepTimer.unref();
}

main().catch(function (e) {
  console.error('[server] 启动失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});

module.exports = { server, sse };
