/* ============================================================
   wzbp · 服务端配置
   ------------------------------------------------------------
   全部配置来自环境变量，带安全默认值。
   服务**只监听 127.0.0.1**，由宝塔 nginx 反代 /api/ 与 /api/stream。

   环境变量：
     WZBP_PORT         监听端口（默认 8787）
     WZBP_DB_HOST      MySQL 主机（默认 127.0.0.1）
     WZBP_DB_PORT      MySQL 端口（默认 3306）
     WZBP_DB_USER      MySQL 用户（默认 root）
     WZBP_DB_PASSWORD  MySQL 密码（默认空）
     WZBP_DB_NAME      MySQL 库名（默认 wzbp）
     WZBP_DB_DRIVER    仅自检用：memory = 内存驱动（非真实 MySQL）
   ============================================================ */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 监听地址写死本机：契约 §9 要求只监听 127.0.0.1，不给环境变量留口子 */
const HOST = '127.0.0.1';

function envStr(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return def;
  return String(raw);
}

function envInt(name, def) {
  const raw = envStr(name, '').trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function envIntIn(name, def, min, max) {
  const n = envInt(name, def);
  if (n < min || n > max) return def;
  return n;
}

/* 库名会拼进 SQL（CREATE DATABASE / USE），必须白名单校验，防注入 */
function safeDbName(raw) {
  const name = String(raw || '').trim();
  if (/^[A-Za-z0-9_$]{1,64}$/.test(name)) return name;
  return 'wzbp';
}

function readVersion() {
  try {
    const pkg = require(path.join(ROOT, 'package.json'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch (e) { /* package.json 缺失时用兜底版本号 */ }
  return '1.0.0';
}

const driver = envStr('WZBP_DB_DRIVER', 'mysql').trim().toLowerCase() === 'memory'
  ? 'memory'
  : 'mysql';

const config = {
  host: HOST,
  port: envIntIn('WZBP_PORT', 8787, 1, 65535),
  root: ROOT,
  version: readVersion(),
  /* 自检用内存驱动（非真实 MySQL，仅 WZBP_DB_DRIVER=memory 时启用） */
  driver,

  db: {
    host: envStr('WZBP_DB_HOST', '127.0.0.1').trim() || '127.0.0.1',
    port: envIntIn('WZBP_DB_PORT', 3306, 1, 65535),
    user: envStr('WZBP_DB_USER', 'root').trim() || 'root',
    password: envStr('WZBP_DB_PASSWORD', ''),
    name: safeDbName(envStr('WZBP_DB_NAME', 'wzbp')),
    connectionLimit: envIntIn('WZBP_DB_POOL', 10, 1, 50),
    connectTimeout: envIntIn('WZBP_DB_CONNECT_TIMEOUT', 10000, 1000, 60000)
  },

  sse: {
    pingMs: 20000,        // 契约 §5：每 20 秒 ping
    staleMs: 30000,       // 契约 §5：30 秒无心跳清理连接
    sweepMs: 10000        // 清理巡检间隔
  },

  bodyLimit: 64 * 1024,   // JSON 请求体上限
  roomListLimit: 50,      // 契约 §3：房间列表最多 50 个
  recentGameLimit: 30,    // 契约 §3：最近对局最多 30 条
  codeRetry: 10           // 契约 §3.1：房间号冲突最多重试 10 次
};

/* 启动日志用：**不打印密码明文** */
config.describe = function describe() {
  const masked = config.db.password ? '******（已设置）' : '（空）';
  return {
    listen: `${config.host}:${config.port}`,
    db: `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name} 密码 ${masked}` +
        (config.driver === 'memory' ? ' [内存驱动·非真实 MySQL]' : ''),
    root: config.root
  };
};

module.exports = config;
