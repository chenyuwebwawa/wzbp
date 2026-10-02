/* ============================================================
   wzbp · MySQL 连接池（mysql2/promise）
   ------------------------------------------------------------
   · 启动时自动建库建表（schema.sql，可重复执行）
   · 导出 query / execute / getPool / isHealthy
   · 连不上时打印**中文排查提示**并以退出码 1 结束

   时间字段一律 DATETIME(3)，连接池固定 timezone:'Z'：
   写入按 UTC 落库、读出按 UTC 解析，回放的 gapMs 与前端 ISO 时间
   不受服务器本地时区影响。

   自检开关：WZBP_DB_DRIVER=memory → 走 server/memory-driver.js
   （内存实现，**不是真实 MySQL**，仅供没有数据库的机器跑自检）。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let mysql = null;         // mysql2/promise
let pool = null;          // 真实连接池
let memory = null;        // 内存驱动
let healthy = false;
let healthCheckedAt = 0;
let booting = false;

const HEALTH_TTL = 2000;  // 健康检查结果缓存 2 秒，避免 /api/health 打爆数据库

/* ---------------- schema.sql 解析 ---------------- */

/* 去掉 `--` 行内注释，并按分号切分语句（本文件里没有存储过程/字符串内分号） */
function splitStatements(sql) {
  return String(sql)
    .split(/\r?\n/)
    .map(function (line) {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n')
    .split(';')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function readSchema() {
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
  /* schema.sql 里库名写死为 wzbp（契约 §2）；配置改名时同步改写 */
  if (config.db.name !== 'wzbp') return raw.split('`wzbp`').join('`' + config.db.name + '`');
  return raw;
}

/* ---------------- 中文排查提示 ---------------- */

function fatal(msg, err) {
  const detail = err ? (err.code ? `${err.code}：${err.message}` : err.message) : '';
  console.error('');
  console.error('[db] 数据库初始化失败' + (detail ? ' —— ' + detail : ''));
  if (msg) console.error('[db] ' + msg);
  console.error('[db] 请依次检查：');
  console.error('[db]   1) 宝塔面板 → 软件商店 → MySQL 是否已启动（面板首页能看到运行状态）；');
  console.error('[db]   2) 用户名/密码是否正确：环境变量 WZBP_DB_USER / WZBP_DB_PASSWORD；');
  console.error('[db]   3) MySQL 是否允许 127.0.0.1 连接（宝塔 → 数据库 → 权限设为「所有人」或本机）；');
  console.error('[db]   4) 端口是否一致：环境变量 WZBP_DB_PORT（默认 3306）；');
  console.error('[db]   5) 依赖是否装好：项目根目录执行 npm install（需要 mysql2）。');
  console.error('[db] 也可以先用 WZBP_DB_DRIVER=memory 启动（内存驱动、无持久化，仅用于自检）。');
  console.error('');
  process.exit(1);
}

function loadMysql() {
  if (mysql) return mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (e) {
    fatal('没有找到 mysql2 模块，请先在项目根目录执行 npm install。', e);
  }
  return mysql;
}

/* ---------------- 初始化 ---------------- */

async function init() {
  if (booting) return;
  booting = true;

  if (config.driver === 'memory') {
    memory = require('./memory-driver');
    await memory.init();
    healthy = true;
    booting = false;
    console.warn('[db] 警告：当前使用**内存驱动**（WZBP_DB_DRIVER=memory），数据不落库、重启即清空，仅供自检。');
    return;
  }

  const m = loadMysql();
  const { host, port, user, password, name } = config.db;

  /* 1) 先用「不指定库」的连接建库（首次部署时库还不存在） */
  let boot = null;
  try {
    boot = await m.createConnection({
      host, port, user, password,
      connectTimeout: config.db.connectTimeout,
      charset: 'utf8mb4',
      multipleStatements: false,
      timezone: 'Z'
    });
  } catch (e) {
    booting = false;
    fatal('连不上 MySQL（' + user + '@' + host + ':' + port + '）。', e);
  }

  try {
    const statements = splitStatements(readSchema());
    for (let i = 0; i < statements.length; i++) {
      await boot.query(statements[i]);
    }
  } catch (e) {
    try { await boot.end(); } catch (e2) { /* 忽略 */ }
    booting = false;
    fatal('建库建表失败（schema.sql 执行出错），请确认账号有 CREATE 权限。', e);
  }

  try { await boot.end(); } catch (e) { /* 忽略 */ }

  /* 2) 建连接池 */
  try {
    pool = m.createPool({
      host, port, user, password,
      database: name,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      queueLimit: 0,
      connectTimeout: config.db.connectTimeout,
      charset: 'utf8mb4',
      timezone: 'Z',                 // DATETIME 一律按 UTC 读写
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: false,
      multipleStatements: false,
      namedPlaceholders: false
    });
    await pool.query('SELECT 1');
  } catch (e) {
    booting = false;
    fatal('连接池建立失败（库 ' + name + '）。', e);
  }

  healthy = true;
  healthCheckedAt = Date.now();
  booting = false;
}

/* ---------------- 对外查询接口 ---------------- */

/** 查询：返回行数组（INSERT/UPDATE 时返回 mysql2 的 OkPacket） */
async function query(sql, params) {
  if (memory) return memory.query(sql, params || []);
  if (!pool) throw new Error('数据库尚未初始化（db.query 在 init 之前被调用）');
  const rows = await pool.query(sql, params || []);
  return rows[0];
}

/** 预处理语句查询：语义同上，走 mysql2 的 execute */
async function execute(sql, params) {
  if (memory) return memory.execute(sql, params || []);
  if (!pool) throw new Error('数据库尚未初始化（db.execute 在 init 之前被调用）');
  const rows = await pool.execute(sql, params || []);
  return rows[0];
}

function getPool() {
  return pool;
}

/** 健康检查（带 2 秒缓存）；失败不清空连接池，仅返回 false */
async function isHealthy() {
  if (memory) return true;
  if (!pool) return false;
  const now = Date.now();
  if (now - healthCheckedAt < HEALTH_TTL) return healthy;
  healthCheckedAt = now;
  try {
    await pool.query('SELECT 1');
    healthy = true;
  } catch (e) {
    healthy = false;
  }
  return healthy;
}

async function close() {
  if (memory) { await memory.close(); memory = null; return; }
  if (pool) {
    const p = pool;
    pool = null;
    try { await p.end(); } catch (e) { /* 忽略 */ }
  }
}

module.exports = {
  init,
  query,
  execute,
  getPool,
  isHealthy,
  close,
  splitStatements,
  SCHEMA_PATH
};
