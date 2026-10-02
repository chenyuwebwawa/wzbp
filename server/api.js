/* ============================================================
   wzbp · REST 实现（契约 §3 / §4 / §5 / §6）
   ------------------------------------------------------------
   · 动作校验以**服务端为准**（契约 §4.1 五条逐条校验）
   · gap_ms 由服务端计算并落库（回放不依赖客户端时钟）
   · SSE 事件：hello / state / action / presence / game / ping
   · 每个事件的 state 都是「按连接个性化」的（me / isMe 每人不同）

   本文件不直接碰 http 与静态文件；index.js 把它挂到 /api/* 上，
   并通过 attach() 注入 SSE 注册表。
   ============================================================ */
'use strict';

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const heroes = require('./heroes');
const draft = require('./draft');

/* ---------------- 常量 ---------------- */

/* 契约 §3.1：6 位房间号，去掉易混字符 I/O/0/1 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const TEAMS = ['blue', 'red'];
const TEAM_SIZE = 5;
const MAX_SLOT = TEAM_SIZE - 1;
const ONLINE_WINDOW_MS = 45000;   // 最近 45 秒有活动也算在线（SSE 断线时兜底）

/* ---------------- SQL（集中一处，便于审查与自检镜像） ---------------- */

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
  /* 注意：action 在 MySQL 里是关键字，列名一律反引号包起来（schema.sql 同样处理） */
  actionInsert: 'INSERT INTO actions (series_id, seq, step_index, side, `action`, hero_id, hero_name, player_key, nickname, acted_at, gap_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  actionDelete: 'DELETE FROM actions WHERE id = ?',
  /* 全局 BP 池：某个房间（= 一个系列赛）里各队选过的英雄，跨小局累计 */
  globalPicks: 'SELECT a.side, a.hero_id FROM actions a JOIN series s ON s.id = a.series_id WHERE s.room_id = ? AND a.`action` = ?',

  recentGames: 'SELECT s.*, r.code AS room_code, r.name AS room_name, (SELECT COUNT(*) FROM actions a WHERE a.series_id = s.id) AS action_count FROM series s JOIN rooms r ON r.id = s.room_id ORDER BY s.started_at DESC, s.id DESC LIMIT 30'
};

/* ---------------- 错误 ---------------- */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new ApiError(status, code, message); }
function isDup(e) {
  return !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062);
}

/* ---------------- 小工具 ---------------- */

function nowDate() { return new Date(); }

function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isPlainNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function numOr(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function sideName(side) { return side === 'blue' ? '蓝方' : (side === 'red' ? '红方' : '双方'); }

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function normalizeCode(raw) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(code)) return '';
  return code;
}

function jsonColumn(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  return v;
}

/* ---------------- 请求解析 ---------------- */

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'ERR_BODY_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', function (e) { reject(e); });
  });
}

async function readJson(req) {
  const raw = await readBody(req, config.bodyLimit);
  if (!raw || !raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
    return {};
  } catch (e) {
    fail(400, 'ERR_BAD_JSON', '请求体不是合法 JSON');
  }
}

/* 契约 §1：playerKey 优先取请求头，其次 body，再其次 query（SSE/GET 用） */
function playerKeyOf(req, body, url) {
  let key = req.headers['x-player-key'];
  if (!key && body && body.playerKey !== undefined && body.playerKey !== null) key = body.playerKey;
  if (!key && url && url.searchParams) key = url.searchParams.get('playerKey');
  return key === null || key === undefined ? '' : String(key).trim();
}

function requirePlayerKey(req, body, url) {
  const key = playerKeyOf(req, body, url);
  if (!key) fail(400, 'ERR_NO_PLAYER_KEY', '缺少 playerKey（身份标识）');
  if (key.length > 64) fail(400, 'ERR_BAD_PLAYER_KEY', 'playerKey 过长（最多 64 字符）');
  return key;
}

/* 契约 §3.1：昵称 1..20 字符，空则「玩家+4 位随机」 */
function normalizeNickname(raw) {
  let n = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!n) n = '玩家' + String(crypto.randomInt(1000, 10000));
  if (n.length > 20) fail(400, 'ERR_BAD_NICKNAME', '昵称最长 20 个字符');
  return n;
}

/* ---------------- 查询封装 ---------------- */

async function mustRoom(codeRaw) {
  const code = normalizeCode(codeRaw);
  if (!code) fail(404, 'ERR_ROOM_NOT_FOUND', '房间号不合法');
  const rows = await db.query(SQL.roomByCode, [code]);
  if (!rows.length) fail(404, 'ERR_ROOM_NOT_FOUND', '房间不存在（房号 ' + code + '）');
  return rows[0];
}

async function listPlayers(roomId) {
  return db.query(SQL.playerList, [roomId]);
}

async function findPlayer(roomId, playerKey) {
  const players = await listPlayers(roomId);
  return players.filter(function (p) { return p.player_key === playerKey; })[0] || null;
}

async function requireMember(room, playerKey) {
  const me = await findPlayer(room.id, playerKey);
  if (!me) fail(403, 'ERR_NOT_IN_ROOM', '你不在这个房间里（请先入房）');
  return me;
}

async function listActions(seriesId) {
  return db.query(SQL.actionList, [seriesId]);
}

/* 本局蓝图：库里存了就用库里的（random），否则用内置赛制镜像（契约 §4） */
function orderOf(room, series) {
  const stored = draft.sanitizeOrder(jsonColumn(series && series.order_json));
  if (stored) return stored;
  const builtin = draft.orderFor(room.mode);
  if (builtin) return builtin;
  return draft.orderFor('ranked');
}

/* 取当前这一局；不存在就补建（避免半途中断留下没有 series 的房间） */
async function ensureSeries(room) {
  const gameNo = Math.max(1, Number(room.current_game) || 1);
  const rows = await db.query(SQL.seriesByGame, [room.id, gameNo]);
  if (rows.length) return rows[0];
  const mode = draft.isMode(room.mode) ? room.mode : 'ranked';
  const order = draft.isMode(mode) && mode === 'random' ? draft.shuffleOrder(draft.RANDOM_BASE) : null;
  const started = nowDate();
  const r = await db.query(SQL.seriesInsert, [room.id, gameNo, mode, order ? JSON.stringify(order) : null, 'drafting', null, started]);
  return {
    id: r.insertId, room_id: room.id, game_no: gameNo, mode,
    order_json: order, status: 'drafting', winner: null,
    started_at: started, finished_at: null
  };
}

/* ---------------- JSON 组装（契约 §4） ---------------- */

function roomJson(room) {
  return {
    code: room.code,
    name: room.name,
    mode: room.mode,
    seriesCount: Number(room.series_count),
    status: room.status,
    currentGame: Number(room.current_game),
    createdAt: toIso(room.created_at),
    updatedAt: toIso(room.updated_at)
  };
}

function actionJson(a) {
  return {
    seq: Number(a.seq),
    stepIndex: Number(a.step_index),
    side: a.side,
    action: a.action,
    heroId: Number(a.hero_id),
    heroName: a.hero_name,
    playerKey: a.player_key || null,
    nickname: a.nickname || null,
    actedAt: toIso(a.acted_at),
    gapMs: Number(a.gap_ms)
  };
}

function gameJson(series, order, actions, globalUsed) {
  const pos = draft.stepIndexFrom(order, actions);
  const bans = { blue: [], red: [] };
  const picks = { blue: [], red: [] };
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const bag = a.action === 'ban' ? bans : picks;
    if (bag[a.side]) bag[a.side].push(Number(a.hero_id));
  }
  const step = pos.done ? null : order[pos.stepIndex];
  return {
    id: Number(series.id),
    gameNo: Number(series.game_no),
    status: series.status,
    mode: series.mode,
    /* 下一手要用 order 里的第几项（= 已完成的蓝图步数，契约 §4） */
    stepIndex: pos.stepIndex,
    done: pos.done,
    /* 当前这一步已经吃了几手 / 一共要吃几手（'both' + n 的步骤会 >1） */
    actionsInStep: pos.usedInStep,
    stepActions: step ? draft.actionsOfStep(step) : 0,
    nextAction: step ? {
      side: step.s, action: step.a, n: draft.repeatOfStep(step),
      phase: step.p || '', tip: step.t || ''
    } : null,
    bans,
    picks,
    /* 全局 BP（kpl）：本系列赛各队已选英雄，换局不清空、开新房清空 */
    global: draft.isGlobal(series.mode),
    globalUsed: globalUsed || { blue: [], red: [] },
    startedAt: toIso(series.started_at),
    finishedAt: toIso(series.finished_at),
    winner: series.winner === undefined ? null : series.winner
  };
}

function seriesJson(series, order) {
  return {
    id: Number(series.id),
    gameNo: Number(series.game_no),
    status: series.status,
    winner: series.winner === undefined ? null : series.winner,
    order
  };
}

/**
 * 全量状态基座（契约 §4）。players 里的 key 只在服务端内部使用，
 * 由 personalize() 剥离 —— SSE 广播时每个连接的 me/isMe 都不一样。
 */
function stateBase(room, s, onlineKeys) {
  const now = Date.now();
  const meMap = {};
  const pjson = s.players.map(function (p) {
    const seen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
    const online = onlineKeys.has(p.player_key) || (now - seen < ONLINE_WINDOW_MS);
    meMap[p.player_key] = { nickname: p.nickname, team: p.team, slot: Number(p.slot) };
    return {
      key: p.player_key,
      nickname: p.nickname,
      team: p.team,
      slot: Number(p.slot),
      online
    };
  });
  return {
    room: roomJson(room),
    players: pjson,
    series: seriesJson(s.series, s.order),
    game: gameJson(s.series, s.order, s.actions, s.globalUsed),
    actions: s.actions.map(actionJson),
    __me: meMap
  };
}

/* 把状态基座变成某个连接看得到的 JSON（补 me / isMe，去掉内部字段） */
function personalize(base, playerKey) {
  const key = playerKey || '';
  return {
    ok: true,
    room: base.room,
    players: base.players.map(function (p) {
      return {
        nickname: p.nickname,
        team: p.team,
        slot: p.slot,
        isMe: key !== '' && p.key === key,
        online: p.online
      };
    }),
    series: base.series,
    game: base.game,
    actions: base.actions,
    me: base.__me[key] || null
  };
}

/* 全局 BP 池（契约 §6 增补）：本房间各小局里各队「选过」的英雄。
   按 room_id 聚合 → 换局不清空；新房 room_id 不同 → 天然清空；ban 不进池。 */
async function globalUsedOf(roomId) {
  const out = { blue: [], red: [] };
  const rows = await db.query(SQL.globalPicks, [roomId, 'pick']);
  for (let i = 0; i < rows.length; i++) {
    const side = rows[i].side;
    if (!out[side]) continue;
    const id = Number(rows[i].hero_id);
    if (out[side].indexOf(id) === -1) out[side].push(id);
  }
  return out;
}

/* 只有全局 BP 赛制才查库；其它赛制直接给空池 */
async function poolOf(roomId, mode) {
  if (!draft.isGlobal(mode)) return { blue: [], red: [] };
  return globalUsedOf(roomId);
}

async function loadState(room) {
  const series = await ensureSeries(room);
  const players = await listPlayers(room.id);
  const actions = await listActions(series.id);
  const order = orderOf(room, series);
  const globalUsed = await poolOf(room.id, series.mode);
  return { series, players, actions, order, globalUsed };
}

async function buildState(room, playerKey) {
  const s = await loadState(room);
  return personalize(
    stateBase(room, s, online.playerKeys(room.code)),
    playerKey
  );
}

/* ---------------- SSE 注册表（index.js 注入） ---------------- */

const online = {
  registry: null,
  keys: new Map(),        // code -> Set(playerKey)（自检/无 SSE 时的兜底）
  playerKeys(code) {
    if (online.registry && typeof online.registry.onlineKeys === 'function') {
      return online.registry.onlineKeys(code);
    }
    return online.keys.get(code) || new Set();
  }
};

function attach(deps) {
  online.registry = (deps && deps.sse) || null;
}

function sseBroadcast(code, event, payload) {
  if (online.registry) online.registry.broadcast(code, event, payload);
}

/* 全房间广播 state（按连接个性化） */
async function broadcastState(room) {
  if (!online.registry) return;
  const s = await loadState(room);
  const base = stateBase(room, s, online.playerKeys(room.code));
  sseBroadcast(room.code, 'state', function (client) {
    return personalize(base, client.playerKey);
  });
}

/* 成员进出：presence + state */
async function broadcastPresence(room) {
  if (!online.registry) return;
  const players = await listPlayers(room.id);
  const onlineKeys = online.playerKeys(room.code);
  const now = Date.now();
  const list = players.map(function (p) {
    const seen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
    return {
      key: p.player_key,
      nickname: p.nickname,
      team: p.team,
      slot: Number(p.slot),
      online: onlineKeys.has(p.player_key) || (now - seen < ONLINE_WINDOW_MS)
    };
  });
  sseBroadcast(room.code, 'presence', function (client) {
    return {
      players: list.map(function (p) {
        return {
          nickname: p.nickname, team: p.team, slot: p.slot,
          isMe: !!client.playerKey && p.key === client.playerKey,
          online: p.online
        };
      })
    };
  });
  await broadcastState(room);
}

/* index.js 在 SSE 连接建立/断开时回调这里 */
function notifyPresence(code) {
  const c = normalizeCode(code);
  if (!c) return;
  db.query(SQL.roomByCode, [c]).then(function (rows) {
    if (rows.length) return broadcastPresence(rows[0]);
    return null;
  }).catch(function (e) {
    console.error('[api] presence 广播失败：', e && e.message);
  });
}

/* index.js 用它把「谁在线」喂给 api（DB 里的 last_seen 作兜底） */
function onlineKeysOf(code, keys) {
  if (keys) online.keys.set(code, keys);
  return online.keys.get(code) || new Set();
}

/* ---------------- 各端点实现 ---------------- */

async function hHealth(req, res, url) {
  const dbOk = await db.isHealthy();
  return {
    status: 200,
    body: {
      ok: true,
      version: config.version,
      time: new Date().toISOString(),
      db: dbOk,
      heroList: heroes.ok,
      heroCount: heroes.count,
      driver: config.driver
    }
  };
}

/* POST /api/rooms —— 建房（房主自动坐蓝方 0 号位） */
async function hCreateRoom(req, res, url) {
  const body = await readJson(req);
  const mode = String(body.mode === undefined || body.mode === null || body.mode === '' ? 'ranked' : body.mode)
    .trim().toLowerCase();
  if (!draft.isMode(mode)) fail(400, 'ERR_BAD_MODE', '赛制不合法（ranked / kpl / peak / random）');

  const seriesCount = numOr(body.seriesCount, 1);
  if (!Number.isInteger(seriesCount) || seriesCount < 1 || seriesCount > 9) {
    fail(400, 'ERR_BAD_SERIES', '系列赛局数必须是 1..9 的整数');
  }

  const playerKey = requirePlayerKey(req, body, url);
  const nickname = normalizeNickname(body.nickname);
  const name = String(body.name === null || body.name === undefined ? '' : body.name).trim().slice(0, 80);

  const order = mode === 'random' ? draft.shuffleOrder(draft.RANDOM_BASE) : null;
  const now = nowDate();

  let created = null;
  for (let attempt = 0; attempt < config.codeRetry; attempt++) {
    const code = randomCode();
    try {
      const r = await db.query(SQL.roomInsert, [
        code, name, mode, seriesCount, 'waiting', 1,
        order ? JSON.stringify(order) : null, now, now
      ]);
      created = {
        id: r.insertId, code, name, mode,
        series_count: seriesCount, status: 'waiting', current_game: 1,
        order_json: order, created_at: now, updated_at: now
      };
      break;
    } catch (e) {
      if (isDup(e)) continue;   // 房号撞车，重试
      throw e;
    }
  }
  if (!created) fail(500, 'ERR_CODE_GEN', '房间号生成失败，请稍后重试');

  await ensureSeries(created);
  await db.query(SQL.playerInsert, [created.id, playerKey, nickname, 'blue', 0, now, now]);

  const players = await listPlayers(created.id);
  return {
    status: 200,
    body: {
      ok: true,
      room: Object.assign(roomJson(created), { players: playersJson(players, playerKey, new Set([playerKey])) }),
      me: { nickname, team: 'blue', slot: 0 }
    }
  };
}

function playersJson(players, playerKey, onlineKeys) {
  const now = Date.now();
  return players.map(function (p) {
    const seen = p.last_seen ? new Date(p.last_seen).getTime() : 0;
    return {
      nickname: p.nickname, team: p.team, slot: Number(p.slot),
      isMe: !!playerKey && p.player_key === playerKey,
      online: onlineKeys.has(p.player_key) || (now - seen < ONLINE_WINDOW_MS)
    };
  });
}

/* GET /api/rooms —— 房间列表（最多 50，updated_at 倒序） */
async function hListRooms(req, res, url, params) {
  const rows = await db.query(SQL.roomList, []);
  const rooms = rows.map(function (r) {
    return {
      code: r.code,
      name: r.name,
      mode: r.mode,
      status: r.status,
      /* 契约 §3 里 players 未明确：这里给人数，另附 members 数组（同 §4 结构） */
      players: Number(r.player_count || 0),
      playerCount: Number(r.player_count || 0),
      seriesCount: Number(r.series_count),
      currentGame: Number(r.current_game),
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at)
    };
  });
  /* members 需要额外一次查询；房间数量有限（<=50），逐房查询可接受 */
  for (let i = 0; i < rooms.length; i++) {
    const ps = await listPlayers(rows[i].id);
    rooms[i].members = playersJson(ps, '', new Set(online.playerKeys(rooms[i].code)));
  }
  return { status: 200, body: { ok: true, rooms } };
}

/* POST /api/rooms/:code/join —— 入房（契约 §3.2） */
async function hJoin(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);
  const nickname = normalizeNickname(body.nickname);

  let team = String(body.team === undefined || body.team === null || body.team === '' ? 'auto' : body.team)
    .trim().toLowerCase();
  if (team !== 'auto' && TEAMS.indexOf(team) === -1) fail(400, 'ERR_BAD_PARAM', 'team 只能是 blue / red / auto');

  let slot = null;
  if (body.slot !== undefined && body.slot !== null && body.slot !== '') {
    slot = numOr(body.slot, NaN);
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
      fail(400, 'ERR_BAD_SLOT', '座位号必须是 0..' + MAX_SLOT);
    }
  }

  if (room.status === 'finished') fail(409, 'ERR_ROOM_FINISHED', '这个房间的对局已经结束了');

  const players = await listPlayers(room.id);
  const now = nowDate();

  /* 已在房内 → 重连：只更新昵称与 last_seen，保持原队伍与座位（契约 §3.2） */
  const existing = players.filter(function (p) { return p.player_key === playerKey; })[0];
  if (existing) {
    await db.query(SQL.playerUpdate, [nickname, now, existing.id]);
    await db.query(SQL.roomTouch, [now, room.id]);
    const after = await listPlayers(room.id);
    broadcastPresence(room).catch(function () {});
    return {
      status: 200,
      body: {
        ok: true,
        reconnect: true,
        room: Object.assign(roomJson(room), { players: playersJson(after, playerKey, online.playerKeys(room.code)) }),
        me: { nickname, team: existing.team, slot: Number(existing.slot) }
      }
    };
  }

  const counts = { blue: 0, red: 0 };
  const used = { blue: new Set(), red: new Set() };
  players.forEach(function (p) {
    if (counts[p.team] !== undefined) {
      counts[p.team] += 1;
      used[p.team].add(Number(p.slot));
    }
  });

  if (team === 'auto') {
    if (slot !== null) {
      /* 指定了座位又选了自动：挑「这个座位空着」且人少的一队 */
      const free = TEAMS.filter(function (t) { return counts[t] < TEAM_SIZE && !used[t].has(slot); });
      if (!free.length) fail(409, 'ERR_SLOT_TAKEN', '这个座位已经被占用了');
      free.sort(function (a, b) { return counts[a] - counts[b]; });
      team = free[0];
    } else {
      team = counts.blue <= counts.red ? 'blue' : 'red';
    }
  }

  if (counts[team] >= TEAM_SIZE) fail(409, 'ERR_TEAM_FULL', sideName(team) + '已经满 ' + TEAM_SIZE + ' 人');

  if (slot === null) {
    slot = -1;
    for (let i = 0; i <= MAX_SLOT; i++) {
      if (!used[team].has(i)) { slot = i; break; }
    }
    if (slot < 0) fail(409, 'ERR_TEAM_FULL', sideName(team) + '已经没有空位');
  } else if (used[team].has(slot)) {
    fail(409, 'ERR_SLOT_TAKEN', sideName(team) + '的 ' + (slot + 1) + ' 号位已经被占用');
  }

  await db.query(SQL.playerInsert, [room.id, playerKey, nickname, team, slot, now, now]);
  await db.query(SQL.roomTouch, [now, room.id]);
  const after = await listPlayers(room.id);
  broadcastPresence(room).catch(function () {});
  return {
    status: 200,
    body: {
      ok: true,
      room: Object.assign(roomJson(room), { players: playersJson(after, playerKey, online.playerKeys(room.code)) }),
      me: { nickname, team, slot }
    }
  };
}

/* POST /api/rooms/:code/leave */
async function hLeave(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);
  const r = await db.query(SQL.playerDelete, [room.id, playerKey]);
  if (r && r.affectedRows) {
    await db.query(SQL.roomTouch, [nowDate(), room.id]);
    broadcastPresence(room).catch(function () {});
  }
  return { status: 200, body: { ok: true, removed: !!(r && r.affectedRows) } };
}

/* GET /api/rooms/:code/state */
async function hState(req, res, url, params) {
  const room = await mustRoom(params.code);
  const playerKey = playerKeyOf(req, null, url);
  const body = await buildState(room, playerKey);
  return { status: 200, body };
}

/* GET /api/stream —— SSE（契约 §5） */
async function hStream(req, res, url) {
  const room = await mustRoom(url.searchParams.get('code'));
  if (!online.registry) fail(500, 'ERR_NO_SSE', 'SSE 注册表未初始化');
  const playerKey = playerKeyOf(req, null, url);

  const client = online.registry.open(req, res, { code: room.code, playerKey });
  if (playerKey) {
    db.query(SQL.playerTouch, [nowDate(), room.id, playerKey]).catch(function () { /* 非成员也要能看直播 */ });
  }
  const state = await buildState(room, playerKey);
  online.registry.send(client, 'state', state);
  return { handled: true };
}

/* POST /api/rooms/:code/shuffle —— 重洗随机顺序（契约 §6） */
async function hShuffle(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);
  await requireMember(room, playerKey);

  if (room.mode !== 'random') fail(409, 'ERR_NOT_RANDOM', '只有「随机征召」模式才能重洗顺序');
  const series = await ensureSeries(room);
  if (series.status !== 'drafting') fail(409, 'ERR_GAME_DONE', '这一局已经结束了');
  const actions = await listActions(series.id);
  if (actions.length) fail(409, 'ERR_ALREADY_STARTED', '已经落子了，不能再重洗顺序');

  const order = draft.shuffleOrder(draft.RANDOM_BASE);
  await db.query(SQL.seriesOrder, [JSON.stringify(order), series.id]);
  await db.query(SQL.roomOrder, [JSON.stringify(order), nowDate(), room.id]);
  broadcastState(room).catch(function () {});
  return { status: 200, body: { ok: true, order } };
}

/* POST /api/rooms/:code/action —— 落一手（契约 §4.1 服务端权威校验） */
async function hAction(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);

  /* 5) 请求方必须在这个房间里（最基础的鉴权放在最前面） */
  const me = await requireMember(room, playerKey);
  if (room.status === 'finished') fail(409, 'ERR_ROOM_FINISHED', '整场系列赛已经结束');

  const side = String(body.side === undefined || body.side === null ? '' : body.side).trim().toLowerCase();
  const act = String(body.action === undefined || body.action === null ? '' : body.action).trim().toLowerCase();
  if (TEAMS.indexOf(side) === -1) fail(400, 'ERR_BAD_PARAM', 'side 只能是 blue / red');
  if (act !== 'ban' && act !== 'pick') fail(400, 'ERR_BAD_PARAM', 'action 只能是 ban / pick');

  const heroId = numOr(body.heroId, NaN);
  if (!Number.isInteger(heroId) || heroId <= 0) fail(400, 'ERR_BAD_PARAM', 'heroId 必须是正整数');

  /* 并发抢同一手时唯一键会冲突 → 重读状态再算一次（最多 3 次） */
  let created = null;
  let finalSeries = null;
  let finalOrder = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const series = await ensureSeries(room);
    /* 1) 房间存在、系列处于 drafting */
    if (series.status !== 'drafting') fail(409, 'ERR_GAME_DONE', '这一局已经结束了');
    const order = orderOf(room, series);
    const actions = await listActions(series.id);
    const pos = draft.stepIndexFrom(order, actions);
    const step = order[pos.stepIndex];
    if (!step) fail(409, 'ERR_GAME_DONE', '本局 BP 已经结束（换局或撤销后再试）');

    /* 2) side / action 必须与蓝图一致（'both' 允许双方） */
    if (step.a !== act) {
      fail(409, 'ERR_WRONG_ACTION', '当前是' + (step.a === 'ban' ? '禁用' : '选择') + '阶段，不能' +
        (act === 'ban' ? '禁用' : '选择'));
    }
    const allow = draft.sidesOfStep(step);
    if (allow.indexOf(side) === -1) {
      fail(409, 'ERR_NOT_YOUR_TURN', '当前轮到' + sideName(allow[0]) + (step.a === 'ban' ? '禁用' : '选择'));
    }
    /* 'both' 步骤里每一方各自有 n 手的配额 */
    const repeat = draft.repeatOfStep(step);
    if (step.s === 'both') {
      const usedBySide = actions.filter(function (a) {
        return Number(a.step_index) === pos.stepIndex && a.side === side;
      }).length;
      if (usedBySide >= repeat) {
        fail(409, 'ERR_NOT_YOUR_TURN', sideName(side) + '本步已经出满 ' + repeat + ' 手');
      }
    }
    /* 容量兜底：镜像 js/draft.js 的 cap 校验，防止蓝图配错时越界写入 */
    const cap = draft.capacities(order);
    const usedCap = actions.filter(function (a) {
      return a.side === side && a.action === act;
    }).length;
    if (usedCap >= cap[side][act]) {
      fail(409, 'ERR_NOT_YOUR_TURN', sideName(side) + '的' + (act === 'ban' ? '禁用' : '选择') + '位已满');
    }

    /* 4) 英雄必须存在（白名单提取失败时降级为不校验，契约 §7） */
    if (!heroes.has(heroId)) fail(404, 'ERR_HERO_UNKNOWN', '英雄不存在（id ' + heroId + '）');
    /* 3) 本局不能被 ban/pick 过两次 */
    const taken = actions.some(function (a) { return Number(a.hero_id) === heroId; });
    if (taken) fail(409, 'ERR_HERO_TAKEN', (heroes.nameOf(heroId) || ('英雄 ' + heroId)) + ' 已经被 ban/pick 过了');

    /* 3b) 全局 BP（kpl）：本方在本系列赛选过的英雄，本方后续小局不能再选。
           对方选过的不影响；禁用不进池（池子只由 action='pick' 组成）。 */
    if (act === 'pick' && draft.isGlobal(series.mode)) {
      const used = await globalUsedOf(room.id);
      if (used[side].indexOf(heroId) !== -1) {
        fail(409, 'ERR_HERO_GLOBAL_USED',
          '该英雄已被' + sideName(side) + '在之前的小局选用（全局 BP）');
      }
    }

    const now = nowDate();
    const prev = actions.length ? actions[actions.length - 1] : null;
    const from = prev ? new Date(prev.acted_at) : new Date(series.started_at);
    let gapMs = now.getTime() - from.getTime();
    if (!Number.isFinite(gapMs) || gapMs < 0) gapMs = 0;
    if (gapMs > 2147483647) gapMs = 2147483647;

    const seq = actions.length + 1;
    const heroName = heroes.nameOf(heroId) || ('英雄' + heroId);
    try {
      const r = await db.query(SQL.actionInsert, [
        series.id, seq, pos.stepIndex, side, act, heroId, heroName,
        playerKey, me.nickname, now, Math.round(gapMs)
      ]);
      created = {
        id: r.insertId, series_id: series.id, seq, step_index: pos.stepIndex,
        side, action: act, hero_id: heroId, hero_name: heroName,
        player_key: playerKey, nickname: me.nickname, acted_at: now, gap_ms: Math.round(gapMs)
      };
      finalSeries = series;
      finalOrder = order;
      break;
    } catch (e) {
      if (isDup(e) && attempt < 2) continue;
      throw e;
    }
  }
  if (!created) fail(409, 'ERR_CONFLICT', '落子冲突，请重试');

  /* 房间：waiting → drafting，并刷新 updated_at */
  const nextStatus = room.status === 'waiting' ? 'drafting' : room.status;
  await db.query(SQL.roomStatus, [nextStatus, nowDate(), room.id]);

  const after = await listActions(finalSeries.id);
  const game = gameJson(finalSeries, finalOrder, after, await poolOf(room.id, finalSeries.mode));
  const actionPayload = actionJson(created);

  /* 契约 §5：先 action（音效/动画），再 state（全量） */
  sseBroadcast(room.code, 'action', { action: actionPayload, game });
  await broadcastState(room);

  return { status: 200, body: { ok: true, action: actionPayload, game } };
}

/* POST /api/rooms/:code/undo —— 撤销上一手 */
async function hUndo(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);
  await requireMember(room, playerKey);

  const series = await ensureSeries(room);
  if (series.status !== 'drafting') fail(409, 'ERR_GAME_DONE', '这一局已经结束，撤销不了');
  const actions = await listActions(series.id);
  if (!actions.length) fail(409, 'ERR_NOTHING_TO_UNDO', '还没有落子，没有可撤销的步骤');

  const last = actions[actions.length - 1];
  await db.query(SQL.actionDelete, [last.id]);
  await db.query(SQL.roomTouch, [nowDate(), room.id]);

  const after = await listActions(series.id);
  const order = orderOf(room, series);
  const game = gameJson(series, order, after, await poolOf(room.id, series.mode));
  await broadcastState(room);
  return { status: 200, body: { ok: true, removed: actionJson(last), game } };
}

/* POST /api/rooms/:code/next-game —— 结束本局、开下一局 */
async function hNextGame(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);
  await requireMember(room, playerKey);

  let winner = body.winner === undefined || body.winner === null || body.winner === ''
    ? null : String(body.winner).trim().toLowerCase();
  if (winner !== null && TEAMS.indexOf(winner) === -1) {
    fail(400, 'ERR_BAD_WINNER', 'winner 只能是 blue / red 或不传');
  }

  if (room.status === 'finished') fail(409, 'ERR_ROOM_FINISHED', '整场系列赛已经结束了');
  const series = await ensureSeries(room);
  if (series.status === 'done') fail(409, 'ERR_ALREADY_DONE', '这一局已经结算过了');

  const now = nowDate();
  await db.query(SQL.seriesDone, [winner, now, series.id]);
  series.status = 'done';
  series.winner = winner;
  series.finished_at = now;

  const total = Number(room.series_count) || 1;
  /* 全局 BP 池跨小局保留：换局时原样带走（只用 pick 组成，ban 不进池） */
  const pool = await poolOf(room.id, series.mode);
  let game;
  if (Number(room.current_game) >= total) {
    await db.query(SQL.roomStatus, ['finished', now, room.id]);
    room.status = 'finished';
    game = gameJson(series, orderOf(room, series), await listActions(series.id), pool);
  } else {
    const nextNo = Number(room.current_game) + 1;
    const mode = draft.isMode(room.mode) ? room.mode : 'ranked';
    const order = mode === 'random' ? draft.shuffleOrder(draft.RANDOM_BASE) : null;
    await db.query(SQL.roomGame, [nextNo, 'drafting', now, room.id]);
    room.current_game = nextNo;
    room.status = 'drafting';
    const r = await db.query(SQL.seriesInsert, [
      room.id, nextNo, mode, order ? JSON.stringify(order) : null, 'drafting', null, now
    ]);
    const fresh = {
      id: r.insertId, room_id: room.id, game_no: nextNo, mode,
      order_json: order, status: 'drafting', winner: null, started_at: now, finished_at: null
    };
    game = gameJson(fresh, orderOf(room, fresh), [], pool);
  }

  sseBroadcast(room.code, 'game', { game });
  await broadcastState(room);
  return { status: 200, body: { ok: true, game } };
}

/* POST /api/rooms/:code/finish —— 直接结束整个系列 */
async function hFinish(req, res, url, params) {
  const room = await mustRoom(params.code);
  const body = await readJson(req);
  const playerKey = requirePlayerKey(req, body, url);
  await requireMember(room, playerKey);

  const now = nowDate();
  const series = await ensureSeries(room);
  if (series.status === 'drafting') {
    await db.query(SQL.seriesDone, [null, now, series.id]);
  }
  await db.query(SQL.roomStatus, ['finished', now, room.id]);
  room.status = 'finished';

  const fresh = Object.assign({}, series, { status: 'done', winner: series.winner || null, finished_at: now });
  const game = gameJson(fresh, orderOf(room, series), await listActions(series.id), await poolOf(room.id, series.mode));
  sseBroadcast(room.code, 'game', { game });
  await broadcastState(room);
  return { status: 200, body: { ok: true, game } };
}

/* GET /api/rooms/:code/history —— 历史对局列表 */
async function hHistory(req, res, url, params) {
  const room = await mustRoom(params.code);
  const rows = await db.query(SQL.seriesList, [room.id]);
  const games = [];
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    const acts = await listActions(s.id);
    games.push(gameSummary(s, acts, room));
  }
  return { status: 200, body: { ok: true, games } };
}

/* 历史/最近对局的列表项：带双方阵容（前端历史卡片要显示阵容头像，省一次 replay 请求） */
function lineupOf(actions, kind) {
  const out = { blue: [], red: [] };
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.action !== kind || !out[a.side]) continue;
    out[a.side].push(Number(a.hero_id));
  }
  return out;
}

function gameSummary(s, actions, room) {
  const acts = actions || [];
  return {
    id: Number(s.id),
    gameNo: Number(s.game_no),
    mode: s.mode,
    status: s.status,
    winner: s.winner === undefined ? null : s.winner,
    startedAt: toIso(s.started_at),
    finishedAt: toIso(s.finished_at),
    actionCount: acts.length,
    /* 双方阵容（heroId 数组），列表卡片直接用 */
    picks: lineupOf(acts, 'pick'),
    bans: lineupOf(acts, 'ban'),
    roomCode: room ? room.code : (s.room_code || null),
    roomName: room ? room.name : (s.room_name || null)
  };
}

/* GET /api/games/recent —— 最近对局（跨房间，最多 30） */
async function hRecentGames(req, res, url, params) {
  const rows = await db.query(SQL.recentGames, []);
  const games = [];
  for (let i = 0; i < rows.length; i++) {
    const acts = await listActions(rows[i].id);
    games.push(gameSummary(rows[i], acts, null));
  }
  return { status: 200, body: { ok: true, games } };
}

/* GET /api/games/:id/replay —— 回放数据 */
async function hReplay(req, res, url, params) {
  const id = numOr(params.id, NaN);
  if (!Number.isInteger(id) || id <= 0) fail(400, 'ERR_BAD_PARAM', '对局 id 不合法');
  const rows = await db.query(SQL.seriesById, [id]);
  if (!rows.length) fail(404, 'ERR_GAME_NOT_FOUND', '对局不存在（id ' + id + '）');
  const series = rows[0];

  let room = null;
  if (series.room_id) {
    const rs = await db.query(SQL.roomById, [series.room_id]);
    if (rs.length) room = rs[0];
  }

  const actions = await listActions(series.id);
  const order = orderOf(room || { mode: series.mode }, series);
  return {
    status: 200,
    body: {
      ok: true,
      game: gameSummary(series, actions, room),
      order,
      game_state: gameJson(series, order, actions,
        series.room_id ? await poolOf(series.room_id, series.mode) : { blue: [], red: [] }),
      actions: actions.map(actionJson)
    }
  };
}

/* ---------------- 路由 ---------------- */

const ROUTES = [
  { method: 'GET', re: /^\/api\/health\/?$/, handler: hHealth },
  { method: 'GET', re: /^\/api\/rooms\/?$/, handler: hListRooms },
  { method: 'POST', re: /^\/api\/rooms\/?$/, handler: hCreateRoom },
  { method: 'GET', re: /^\/api\/rooms\/([^/]+)\/state\/?$/, handler: hState, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/join\/?$/, handler: hJoin, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/leave\/?$/, handler: hLeave, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/shuffle\/?$/, handler: hShuffle, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/action\/?$/, handler: hAction, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/undo\/?$/, handler: hUndo, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/next-game\/?$/, handler: hNextGame, keys: ['code'] },
  { method: 'POST', re: /^\/api\/rooms\/([^/]+)\/finish\/?$/, handler: hFinish, keys: ['code'] },
  { method: 'GET', re: /^\/api\/rooms\/([^/]+)\/history\/?$/, handler: hHistory, keys: ['code'] },
  { method: 'GET', re: /^\/api\/games\/recent\/?$/, handler: hRecentGames },
  { method: 'GET', re: /^\/api\/games\/([^/]+)\/replay\/?$/, handler: hReplay, keys: ['id'] },
  { method: 'GET', re: /^\/api\/stream\/?$/, handler: hStream }
];

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/** /api/* 统一入口；返回 true 表示已处理（含 SSE 长连接） */
async function handle(req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET,POST,OPTIONS' });
    res.end();
    return true;
  }

  try {
    let pathMatched = false;
    for (let i = 0; i < ROUTES.length; i++) {
      const route = ROUTES[i];
      const m = route.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      (route.keys || []).forEach(function (k, idx) { params[k] = decodeURIComponent(m[idx + 1] || ''); });
      const out = await route.handler(req, res, url, params);
      if (out && out.handled) return true;          // SSE 已接管响应
      if (out && out.status) sendJson(res, out.status, out.body);
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { ok: false, error: '方法不允许：' + method + ' ' + pathname, code: 'ERR_METHOD' });
      return true;
    }
    sendJson(res, 404, { ok: false, error: '接口不存在：' + pathname, code: 'ERR_NOT_FOUND' });
    return true;
  } catch (e) {
    if (e instanceof ApiError) {
      sendJson(res, e.status, { ok: false, error: e.message, code: e.code });
      return true;
    }
    console.error('[api] 500 ' + method + ' ' + pathname, e && e.stack ? e.stack : e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务端内部错误', code: 'ERR_INTERNAL' });
    else { try { res.end(); } catch (e2) { /* 忽略 */ } }
    return true;
  }
}

module.exports = {
  attach,
  handle,
  notifyPresence,
  onlineKeysOf,
  buildState,
  SQL,
  ApiError,
  CODE_ALPHABET,
  TEAM_SIZE
};
