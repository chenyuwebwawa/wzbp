/* ============================================================
   wzbp · 内存数据库驱动（**不是真实 MySQL**）
   ------------------------------------------------------------
   用途：在没有 MySQL 的机器上把「HTTP 接口 + 服务端校验 + SSE」
   这条链路真跑一遍（npm run verify:memory）。
   仅在环境变量 WZBP_DB_DRIVER=memory 时被 db.js 加载。

   实现方式：把 api.js 用到的每一条 SQL 按「规范化后的原文」精确匹配，
   在内存表上执行等价操作，并模拟 UNIQUE 约束（撞唯一键抛 ER_DUP_ENTRY，
   与 MySQL 一致）。**任何未登记的 SQL 都会直接抛错**，所以它不会
   悄悄放过新语句；但它的 SQL 语义毕竟是自己写的，不能替代真实 MySQL 验证。
   ============================================================ */
'use strict';

const tables = { rooms: [], players: [], series: [], actions: [] };
const seqs = { rooms: 0, players: 0, series: 0, actions: 0 };

/* ---------------- 与 api.js 完全一致的 SQL 原文 ---------------- */

const SQL = {
  roomByCode: 'SELECT * FROM rooms WHERE code = ? LIMIT 1',
  roomById: 'SELECT * FROM rooms WHERE id = ? LIMIT 1',
  roomInsert: 'INSERT INTO rooms (code, name, mode, series_count, status, current_game, order_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  roomList: 'SELECT r.*, (SELECT COUNT(*) FROM players p WHERE p.room_id = r.id) AS player_count FROM rooms r ORDER BY r.updated_at DESC, r.id DESC LIMIT 50',
  roomStatus: 'UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?',
  roomGame: 'UPDATE rooms SET current_game = ?, status = ?, updated_at = ? WHERE id = ?',
  roomOrder: 'UPDATE rooms SET order_json = ?, updated_at = ? WHERE id = ?',
  roomTouch: 'UPDATE rooms SET updated_at = ? WHERE id = ?',

  playerList: 'SELECT * FROM players WHERE room_id = ? ORDER BY team ASC, slot ASC',
  playerInsert: 'INSERT INTO players (room_id, player_key, nickname, team, slot, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
  playerUpdate: 'UPDATE players SET nickname = ?, last_seen = ? WHERE id = ?',
  playerTouch: 'UPDATE players SET last_seen = ? WHERE room_id = ? AND player_key = ?',
  playerDelete: 'DELETE FROM players WHERE room_id = ? AND player_key = ?',

  seriesByGame: 'SELECT * FROM series WHERE room_id = ? AND game_no = ? LIMIT 1',
  seriesById: 'SELECT * FROM series WHERE id = ? LIMIT 1',
  seriesList: 'SELECT * FROM series WHERE room_id = ? ORDER BY game_no DESC',
  seriesInsert: 'INSERT INTO series (room_id, game_no, mode, order_json, status, winner, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  seriesDone: "UPDATE series SET status = 'done', winner = ?, finished_at = ? WHERE id = ?",
  seriesOrder: 'UPDATE series SET order_json = ? WHERE id = ?',

  actionList: 'SELECT * FROM actions WHERE series_id = ? ORDER BY seq ASC',
  actionInsert: 'INSERT INTO actions (series_id, seq, step_index, side, `action`, hero_id, hero_name, player_key, nickname, acted_at, gap_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  actionDelete: 'DELETE FROM actions WHERE id = ?',
  globalPicks: 'SELECT a.side, a.hero_id FROM actions a JOIN series s ON s.id = a.series_id WHERE s.room_id = ? AND a.`action` = ?',

  recentGames: 'SELECT s.*, r.code AS room_code, r.name AS room_name, (SELECT COUNT(*) FROM actions a WHERE a.series_id = s.id) AS action_count FROM series s JOIN rooms r ON r.id = s.room_id ORDER BY s.started_at DESC, s.id DESC LIMIT 30'
};

const norm = function (sql) { return String(sql).replace(/\s+/g, ' ').trim(); };

/* 规范化后的 SQL → 处理器 */
let HANDLERS = null;

/* ---------------- 工具 ---------------- */

function dupEntry(msg) {
  const e = new Error(msg || 'Duplicate entry');
  e.code = 'ER_DUP_ENTRY';
  e.errno = 1062;
  return e;
}

function rowCopy(r) { return Object.assign({}, r); }

function rowsCopy(list) { return list.map(rowCopy); }

function insertOk(id) { return { insertId: id, affectedRows: 1, fieldCount: 0, warningStatus: 0 }; }
function updateOk(n) { return { insertId: 0, affectedRows: n, fieldCount: 0, warningStatus: 0 }; }

/* MySQL 的 JSON 列：传字符串存进去，读出来是对象 */
function asJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { throw new Error('Invalid JSON text'); }
  }
  return v;
}

function timeOf(v) {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

function byId(table, id) {
  for (let i = 0; i < table.length; i++) if (Number(table[i].id) === Number(id)) return table[i];
  return null;
}

/* ---------------- 建表（模拟初始化） ---------------- */

function reset() {
  tables.rooms.length = 0;
  tables.players.length = 0;
  tables.series.length = 0;
  tables.actions.length = 0;
  seqs.rooms = 0;
  seqs.players = 0;
  seqs.series = 0;
  seqs.actions = 0;
}

async function init() {
  reset();
  HANDLERS = buildHandlers();

  /* 与 api.js 的 SQL 原文做一次交叉校验：任何一条对不上就立刻报错，
     避免「api.js 改了 SQL、内存驱动还在按旧语句匹配」这种假通过 */
  try {
    const api = require('./api');
    Object.keys(api.SQL).forEach(function (k) {
      if (!SQL[k]) throw new Error('内存驱动缺少 SQL 定义：' + k);
      if (norm(api.SQL[k]) !== norm(SQL[k])) {
        throw new Error('SQL 不一致 [' + k + ']\n  api.js : ' + norm(api.SQL[k]) + '\n  驱动  : ' + norm(SQL[k]));
      }
    });
  } catch (e) {
    if (e && /内存驱动缺少|SQL 不一致/.test(String(e.message))) throw e;
    /* api.js 尚未加载时（极少数情况）跳过交叉校验 */
  }
  return true;
}

/* ---------------- 语句实现 ---------------- */

function buildHandlers() {
  const h = new Map();

  h.set(norm(SQL.roomByCode), function (p) {
    const code = String(p[0]);
    return rowsCopy(tables.rooms.filter(function (r) { return r.code === code; }).slice(0, 1));
  });

  h.set(norm(SQL.roomById), function (p) {
    const r = byId(tables.rooms, p[0]);
    return r ? [rowCopy(r)] : [];
  });

  h.set(norm(SQL.roomInsert), function (p) {
    const code = String(p[0]);
    if (tables.rooms.some(function (r) { return r.code === code; })) {
      throw dupEntry("Duplicate entry '" + code + "' for key 'rooms.code'");
    }
    seqs.rooms += 1;
    tables.rooms.push({
      id: seqs.rooms,
      code, name: p[1], mode: p[2],
      series_count: Number(p[3]), status: p[4], current_game: Number(p[5]),
      order_json: asJson(p[6]), created_at: p[7], updated_at: p[8]
    });
    return insertOk(seqs.rooms);
  });

  h.set(norm(SQL.roomList), function () {
    const list = tables.rooms.slice().sort(function (a, b) {
      return (timeOf(b.updated_at) - timeOf(a.updated_at)) || (Number(b.id) - Number(a.id));
    }).slice(0, 50);
    return list.map(function (r) {
      const out = rowCopy(r);
      out.player_count = tables.players.filter(function (p) { return Number(p.room_id) === Number(r.id); }).length;
      return out;
    });
  });

  h.set(norm(SQL.roomStatus), function (p) {
    const r = byId(tables.rooms, p[2]);
    if (!r) return updateOk(0);
    r.status = p[0];
    r.updated_at = p[1];
    return updateOk(1);
  });

  h.set(norm(SQL.roomGame), function (p) {
    const r = byId(tables.rooms, p[3]);
    if (!r) return updateOk(0);
    r.current_game = Number(p[0]);
    r.status = p[1];
    r.updated_at = p[2];
    return updateOk(1);
  });

  h.set(norm(SQL.roomOrder), function (p) {
    const r = byId(tables.rooms, p[2]);
    if (!r) return updateOk(0);
    r.order_json = asJson(p[0]);
    r.updated_at = p[1];
    return updateOk(1);
  });

  h.set(norm(SQL.roomTouch), function (p) {
    const r = byId(tables.rooms, p[1]);
    if (!r) return updateOk(0);
    r.updated_at = p[0];
    return updateOk(1);
  });

  h.set(norm(SQL.playerList), function (p) {
    return rowsCopy(tables.players.filter(function (x) {
      return Number(x.room_id) === Number(p[0]);
    }).sort(function (a, b) {
      return String(a.team).localeCompare(String(b.team)) || (Number(a.slot) - Number(b.slot));
    }));
  });

  h.set(norm(SQL.playerInsert), function (p) {
    const roomId = Number(p[0]);
    const key = String(p[1]);
    const team = String(p[3]);
    const slot = Number(p[4]);
    if (tables.players.some(function (x) { return Number(x.room_id) === roomId && x.player_key === key; })) {
      throw dupEntry("Duplicate entry for key 'players.uk_room_key'");
    }
    if (tables.players.some(function (x) { return Number(x.room_id) === roomId && x.team === team && Number(x.slot) === slot; })) {
      throw dupEntry("Duplicate entry for key 'players.uk_room_slot'");
    }
    seqs.players += 1;
    tables.players.push({
      id: seqs.players, room_id: roomId, player_key: key, nickname: p[2],
      team, slot, joined_at: p[5], last_seen: p[6]
    });
    return insertOk(seqs.players);
  });

  h.set(norm(SQL.playerUpdate), function (p) {
    const r = byId(tables.players, p[2]);
    if (!r) return updateOk(0);
    r.nickname = p[0];
    r.last_seen = p[1];
    return updateOk(1);
  });

  h.set(norm(SQL.playerTouch), function (p) {
    let n = 0;
    tables.players.forEach(function (x) {
      if (Number(x.room_id) === Number(p[1]) && x.player_key === p[2]) { x.last_seen = p[0]; n += 1; }
    });
    return updateOk(n);
  });

  h.set(norm(SQL.playerDelete), function (p) {
    let n = 0;
    for (let i = tables.players.length - 1; i >= 0; i--) {
      const x = tables.players[i];
      if (Number(x.room_id) === Number(p[0]) && x.player_key === p[1]) { tables.players.splice(i, 1); n += 1; }
    }
    return updateOk(n);
  });

  h.set(norm(SQL.seriesByGame), function (p) {
    return rowsCopy(tables.series.filter(function (s) {
      return Number(s.room_id) === Number(p[0]) && Number(s.game_no) === Number(p[1]);
    }).slice(0, 1));
  });

  h.set(norm(SQL.seriesById), function (p) {
    const s = byId(tables.series, p[0]);
    return s ? [rowCopy(s)] : [];
  });

  h.set(norm(SQL.seriesList), function (p) {
    return rowsCopy(tables.series.filter(function (s) {
      return Number(s.room_id) === Number(p[0]);
    }).sort(function (a, b) { return Number(b.game_no) - Number(a.game_no); }));
  });

  h.set(norm(SQL.seriesInsert), function (p) {
    const roomId = Number(p[0]);
    const gameNo = Number(p[1]);
    if (tables.series.some(function (s) { return Number(s.room_id) === roomId && Number(s.game_no) === gameNo; })) {
      throw dupEntry("Duplicate entry for key 'series.uk_room_game'");
    }
    seqs.series += 1;
    tables.series.push({
      id: seqs.series, room_id: roomId, game_no: gameNo, mode: p[2],
      order_json: asJson(p[3]), status: p[4], winner: p[5] === undefined ? null : p[5],
      started_at: p[6], finished_at: null
    });
    return insertOk(seqs.series);
  });

  h.set(norm(SQL.seriesDone), function (p) {
    const s = byId(tables.series, p[2]);
    if (!s) return updateOk(0);
    s.status = 'done';
    s.winner = p[0] === undefined ? null : p[0];
    s.finished_at = p[1];
    return updateOk(1);
  });

  h.set(norm(SQL.seriesOrder), function (p) {
    const s = byId(tables.series, p[1]);
    if (!s) return updateOk(0);
    s.order_json = asJson(p[0]);
    return updateOk(1);
  });

  h.set(norm(SQL.actionList), function (p) {
    return rowsCopy(tables.actions.filter(function (a) {
      return Number(a.series_id) === Number(p[0]);
    }).sort(function (a, b) { return Number(a.seq) - Number(b.seq); }));
  });

  h.set(norm(SQL.actionInsert), function (p) {
    const seriesId = Number(p[0]);
    const seq = Number(p[1]);
    if (tables.actions.some(function (a) { return Number(a.series_id) === seriesId && Number(a.seq) === seq; })) {
      throw dupEntry("Duplicate entry for key 'actions.uk_series_seq'");
    }
    seqs.actions += 1;
    tables.actions.push({
      id: seqs.actions, series_id: seriesId, seq, step_index: Number(p[2]),
      side: p[3], action: p[4], hero_id: Number(p[5]), hero_name: p[6],
      player_key: p[7], nickname: p[8], acted_at: p[9], gap_ms: Number(p[10])
    });
    return insertOk(seqs.actions);
  });

  h.set(norm(SQL.actionDelete), function (p) {
    for (let i = 0; i < tables.actions.length; i++) {
      if (Number(tables.actions[i].id) === Number(p[0])) {
        tables.actions.splice(i, 1);
        return updateOk(1);
      }
    }
    return updateOk(0);
  });

  /* SELECT a.side, a.hero_id FROM actions a JOIN series s ON s.id = a.series_id
     WHERE s.room_id = ? AND a.`action` = ?  —— 全局 BP 池 */
  h.set(norm(SQL.globalPicks), function (p) {
    const roomId = Number(p[0]);
    const kind = String(p[1]);
    const seriesIds = tables.series
      .filter(function (s) { return Number(s.room_id) === roomId; })
      .map(function (s) { return Number(s.id); });
    const out = [];
    tables.actions.forEach(function (a) {
      if (seriesIds.indexOf(Number(a.series_id)) === -1) return;
      if (String(a.action) !== kind) return;
      out.push({ side: a.side, hero_id: Number(a.hero_id) });
    });
    return out;
  });

  h.set(norm(SQL.recentGames), function () {
    const out = tables.series.map(function (s) {
      const room = byId(tables.rooms, s.room_id);
      const row = rowCopy(s);
      row.room_code = room ? room.code : null;
      row.room_name = room ? room.name : null;
      row.action_count = tables.actions.filter(function (a) {
        return Number(a.series_id) === Number(s.id);
      }).length;
      return row;
    });
    return out.sort(function (a, b) {
      return (timeOf(b.started_at) - timeOf(a.started_at)) || (Number(b.id) - Number(a.id));
    }).slice(0, 30);
  });

  return h;
}

/* ---------------- 对外接口（与 db.js 的形状一致） ---------------- */

async function query(sql, params) {
  if (!HANDLERS) throw new Error('内存驱动尚未初始化');
  const key = norm(sql);
  const fn = HANDLERS.get(key);
  if (!fn) {
    throw new Error('[memory-driver] 未登记的 SQL（内存驱动无法执行）：' + key);
  }
  return fn(params || []);
}

async function execute(sql, params) {
  return query(sql, params);
}

function getPool() { return null; }

async function isHealthy() { return true; }

async function close() { reset(); }

module.exports = {
  init,
  query,
  execute,
  getPool,
  isHealthy,
  close,
  SQL,
  /* 自检用：直接读内存表（例如断言房间/动作条数） */
  _tables: tables,
  _reset: reset
};
