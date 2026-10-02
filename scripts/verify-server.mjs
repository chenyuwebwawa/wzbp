#!/usr/bin/env node
/* ============================================================
   wzbp · 后端自检（契约 §10）
   ------------------------------------------------------------
   只用 Node 内置模块（http / net / child_process / fs），不装测试框架。

   用法：
     node scripts/verify-server.mjs                 真实 MySQL（没有就优雅跳过，退出码 0）
     node scripts/verify-server.mjs --require-db    没有数据库时按失败处理（退出码 1）
     node scripts/verify-server.mjs --memory        内存驱动全流程（**非真实 MySQL**，只验证接口逻辑）
     node scripts/verify-server.mjs --ping          额外等一次 SSE ping（20 秒心跳，默认不测）
     node scripts/verify-server.mjs --base=http://127.0.0.1:8787   直接打已启动的服务

   覆盖：建房 → 入房（auto/重连/指定 slot/满员）→ 三种赛制蓝图 →
         连落一整局 → 重复英雄/越权/错轮次/错动作/未知英雄 → 撤销 →
         换局 → 历史 → 回放（gapMs 非负、首手为距开局）→ SSE(hello/state/action) →
         随机洗牌约束 → 静态文件与路径穿越防护。
   v3 追加：管理员账号（scrypt 哈希 + adminToken）→ 未开局落子被拒（ERR_NOT_LAUNCHED）→
         非管理员 launch 被拒（ERR_NOT_ADMIN/ERR_BAD_TOKEN）→ 登录失败统一 401 ERR_BAD_CREDENTIALS
         （账号不存在与密码错同码同文案）→ 管理员开局 → 服务端权威自动计时
         （turn.deadline/remainingMs、落子后重置、暂停冻结/续上、到 0 不代打）→
         老库幂等迁移（连跑两次 init、已有动作的房间回填 launched=1）。
   ============================================================ */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
};

const OPT = {
  memory: has('--memory'),
  requireDb: has('--require-db'),
  ping: has('--ping'),
  base: valueOf('base'),
  port: Number(valueOf('port') || 8791),
  keep: has('--keep')
};

/* ---------------- 断言 ---------------- */

let PASS = 0;
const FAILURES = [];
let GROUP = '';

function group(name) {
  GROUP = name;
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(2, 56 - name.length)));
}

function check(name, cond, detail) {
  if (cond) {
    PASS += 1;
    console.log('  ✔ ' + name);
  } else {
    FAILURES.push(GROUP + ' / ' + name + (detail ? ' —— ' + detail : ''));
    console.log('  ✘ ' + name + (detail ? ' —— ' + detail : ''));
  }
}

function checkEq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- HTTP 客户端 ---------------- */

function request(method, urlPath, opts = {}) {
  const base = opts.base || BASE;
  const u = new URL(urlPath, base);
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
  const headers = {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(payload.length);
  }
  if (opts.playerKey) headers['X-Player-Key'] = opts.playerKey;
  if (opts.headers) Object.assign(headers, opts.headers);

  return new Promise((resolve, reject) => {
    const req = http.request({
      method, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON（静态文件） */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const api = (method, p, body, playerKey) => request(method, p, { body, playerKey });

/* 原样发送 path（不经 URL 规范化），用于路径穿越测试 */
function rawRequest(method, rawPath) {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: rawPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 忽略 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---------------- SSE 客户端 ---------------- */

function openSse(code, playerKey, adminToken) {
  const u = new URL('/api/stream?code=' + encodeURIComponent(code) +
    (playerKey ? '&playerKey=' + encodeURIComponent(playerKey) : '') +
    (adminToken ? '&adminToken=' + encodeURIComponent(adminToken) : ''), BASE);
  const events = [];
  let buffer = '';
  const state = { headers: null, closed: false };

  const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
    state.headers = res.headers;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let name = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        let data = null;
        try { data = JSON.parse(dataLines.join('\n') || '{}'); } catch (e) { data = null; }
        events.push({ event: name, data, at: Date.now() });
      }
    });
  });
  req.on('error', () => { /* 关闭时的 ECONNRESET 忽略 */ });

  return {
    events,
    headers: () => state.headers,
    count: (name) => events.filter((e) => e.event === name).length,
    first: (name) => events.find((e) => e.event === name) || null,
    async waitFor(name, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = events.find((e) => e.event === name);
        if (hit) return hit;
        await sleep(50);
      }
      return null;
    },
    close() { try { req.destroy(); } catch (e) { /* 忽略 */ } }
  };
}

/* ---------------- 英雄 id（与 server/heroes.js 同一套正则，独立读文件） ---------------- */

function loadHeroIds() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'data', 'heroes.js'), 'utf8');
    const re = /id\s*:\s*(\d{1,6})\s*,\s*name\s*:\s*"([^"]*)"/g;
    const ids = [];
    let m;
    while ((m = re.exec(src)) !== null) ids.push(Number(m[1]));
    return ids.length >= 50 ? ids : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- 蓝图期望值（独立抄一份，用来交叉验证服务端镜像） ---------------- */

const EXPECTED = {
  ranked: [
    'blue:ban', 'red:ban', 'red:ban', 'blue:ban', 'blue:ban', 'red:ban',
    'blue:pick', 'red:pick', 'red:pick', 'blue:pick', 'blue:pick', 'red:pick',
    'red:pick', 'blue:pick', 'blue:pick', 'red:pick'
  ],
  kpl: [
    /* 第一轮禁用：蓝B1 红B1 蓝B1 红B1 */
    'blue:ban', 'red:ban', 'blue:ban', 'red:ban',
    /* 第一轮选择：蓝P1 红P2 蓝P2 红P1 */
    'blue:pick', 'red:pick', 'red:pick', 'blue:pick', 'blue:pick', 'red:pick',
    /* 第二轮禁用：红B1 蓝B1 红B1 蓝B1 */
    'red:ban', 'blue:ban', 'red:ban', 'blue:ban',
    /* 第二轮选择：红P1 蓝P2 红P1 */
    'red:pick', 'blue:pick', 'blue:pick', 'red:pick'
  ],
  peak: [
    'both:ban', 'blue:pick', 'red:pick', 'red:pick', 'blue:pick', 'blue:pick',
    'red:pick', 'red:pick', 'blue:pick', 'blue:pick', 'red:pick'
  ]
};

/* ============================================================
   测试主体
   ============================================================ */

async function runSuite() {
  const P1 = 'verify-p1-' + Date.now();
  const P2 = 'verify-p2-' + Date.now();
  const P3 = 'verify-p3-' + Date.now();
  const P4 = 'verify-p4-' + Date.now();
  const P5 = 'verify-p5-' + Date.now();
  const P6 = 'verify-p6-' + Date.now();
  const OUT = 'verify-outsider-' + Date.now();

  const heroIds = loadHeroIds();

  /* ------------------------------------------------------------
     v3：建房现在必须带管理员账号（adminUser 3..20 位字母数字下划线，adminPass 6..64），
     而且「未开局不能落子」——凡是建完就要落子的房，都顺手让建房时拿到的 adminToken 开局。
     autoLaunch=false 用于只检查蓝图/大厅的房。
     ------------------------------------------------------------ */
  let adminSeq = 0;
  function adminCreds() {
    adminSeq += 1;
    return {
      adminUser: 'vadmin' + Date.now().toString(36) + adminSeq,
      adminPass: 'vpass-' + Date.now() + '-' + adminSeq
    };
  }

  async function newRoom(body, opts) {
    opts = opts || {};
    const payload = Object.assign({ seriesCount: 1 }, body || {});
    if (!payload.adminUser || !payload.adminPass) {
      const c = adminCreds();
      payload.adminUser = c.adminUser;
      payload.adminPass = c.adminPass;
    }
    const res = await api('POST', '/api/rooms', payload);
    const out = {
      res,
      code: (res.json && res.json.room && res.json.room.code) || '',
      token: (res.json && res.json.adminToken) || '',
      adminUser: payload.adminUser,
      adminPass: payload.adminPass
    };
    if (res.json && res.json.ok && opts.autoLaunch !== false) {
      out.launch = await api('POST', '/api/rooms/' + out.code + '/launch', { adminToken: out.token });
    }
    return out;
  }

  /* ---------- 1. health ---------- */
  group('1. /api/health 探活');
  const health = await api('GET', '/api/health');
  checkEq('HTTP 200', health.status, 200);
  check('ok:true', health.json && health.json.ok === true);
  check('返回 version', !!(health.json && health.json.version));
  check('返回 time(ISO)', !!(health.json && /^\d{4}-\d{2}-\d{2}T/.test(health.json.time)));
  checkEq('db:true', health.json && health.json.db, true);
  check('返回 heroList 标记', !!(health.json && typeof health.json.heroList === 'boolean'));
  const heroListOk = !!(health.json && health.json.heroList);
  console.log('    （英雄白名单 heroList=' + heroListOk + '，heroCount=' + (health.json && health.json.heroCount) + '）');

  /* ---------- 2. 建房参数校验 ---------- */
  group('2. 建房参数校验（契约 §3.1 / v3 管理员）');
  const a0 = adminCreds();
  const badMode = await api('POST', '/api/rooms', { name: 'x', mode: 'nope', seriesCount: 1, nickname: 'a', playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  checkEq('非法 mode → 400', badMode.status, 400);
  checkEq('非法 mode → ERR_BAD_MODE', badMode.json && badMode.json.code, 'ERR_BAD_MODE');
  const badSeries0 = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 0, nickname: 'a', playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  checkEq('seriesCount=0 → 400', badSeries0.status, 400);
  const badSeries10 = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 10, nickname: 'a', playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  checkEq('seriesCount=10 → 400', badSeries10.status, 400);
  /* v3：管理员账号必填 */
  const noAdminUser = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, nickname: 'a', playerKey: P1, adminPass: a0.adminPass });
  checkEq('缺 adminUser → 400', noAdminUser.status, 400);
  checkEq('缺 adminUser → ERR_BAD_ADMIN_USER', noAdminUser.json && noAdminUser.json.code, 'ERR_BAD_ADMIN_USER');
  const shortAdminUser = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: 'ab', adminPass: a0.adminPass });
  checkEq('adminUser 只有 2 位 → 400', shortAdminUser.status, 400);
  const badAdminUserChar = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: '教练甲', adminPass: a0.adminPass });
  checkEq('adminUser 含非字母数字下划线 → 400', badAdminUserChar.status, 400);
  const noAdminPass = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: a0.adminUser });
  checkEq('缺 adminPass → 400', noAdminPass.status, 400);
  checkEq('缺 adminPass → ERR_BAD_ADMIN_PASS', noAdminPass.json && noAdminPass.json.code, 'ERR_BAD_ADMIN_PASS');
  const shortPass = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: a0.adminUser, adminPass: '12345' });
  checkEq('密码只有 5 位 → 400', shortPass.status, 400);
  /* v3：turnSeconds 校验（30..300 或 0） */
  const badTurn = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass, turnSeconds: 10 });
  checkEq('turnSeconds=10 → 400', badTurn.status, 400);
  checkEq('turnSeconds=10 → ERR_BAD_TURN_SECONDS', badTurn.json && badTurn.json.code, 'ERR_BAD_TURN_SECONDS');
  const badTurn2 = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass, turnSeconds: 301 });
  checkEq('turnSeconds=301 → 400', badTurn2.status, 400);
  /* v3：playerKey 变成可选（管理员可以不占席位），传了才自动坐蓝方 0 号位 */
  const noPlayerKey = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  checkEq('不传 playerKey 也能建房 → 200', noPlayerKey.status, 200);
  checkEq('不占席位时 me=null', noPlayerKey.json && noPlayerKey.json.me, null);
  checkEq('不占席位时 room.players 为空', noPlayerKey.json && noPlayerKey.json.room.players.length, 0);
  check('建房返回 adminToken（64 位 hex = 32 字节）',
    /^[0-9a-f]{64}$/.test(String(noPlayerKey.json && noPlayerKey.json.adminToken)));
  const longNick = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, nickname: 'x'.repeat(21), playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  checkEq('昵称超过 20 字 → 400', longNick.status, 400);
  const fracSeries = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1.5, nickname: 'a', playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  checkEq('seriesCount 非整数 → 400', fracSeries.status, 400);
  const autoNick = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, nickname: '   ', playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass });
  check('空昵称自动生成「玩家+4位随机」',
    !!(autoNick.json && autoNick.json.room && /^玩家\d{4}$/.test(autoNick.json.room.players[0].nickname)),
    autoNick.json && autoNick.json.room && autoNick.json.room.players[0].nickname);
  /* v3：不限时房（turnSeconds=0）合法 */
  const unlimited = await api('POST', '/api/rooms', { mode: 'ranked', seriesCount: 1, playerKey: P1, adminUser: a0.adminUser, adminPass: a0.adminPass, turnSeconds: 0 });
  checkEq('turnSeconds=0（不限时）→ 200', unlimited.status, 200);
  checkEq('不限时房 room.turnSeconds=0', unlimited.json && unlimited.json.room.turnSeconds, 0);

  /* ---------- 3. 建房（ranked，BO2） ---------- */
  group('3. 建房 + 蓝图镜像（ranked / kpl / peak）');
  const createdRoom = await newRoom({ name: '自检房', mode: 'ranked', seriesCount: 2, nickname: '房主', playerKey: P1 });
  const created = createdRoom.res;
  checkEq('建房 HTTP 200', created.status, 200);
  checkEq('建房后自动开局（管理员 launch）HTTP 200', createdRoom.launch && createdRoom.launch.status, 200);
  const room = created.json && created.json.room;
  check('返回 room.code（6 位、字符集不含 I/O/0/1）',
    !!room && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(room.code), room && room.code);
  checkEq('mode=ranked', room && room.mode, 'ranked');
  checkEq('seriesCount=2', room && room.seriesCount, 2);
  checkEq('房主自动坐蓝方 0 号位', created.json && created.json.me && created.json.me.team + ':' + created.json.me.slot, 'blue:0');
  checkEq('建房响应里 launched=false（还没点开始 BP）', room && room.launched, false);
  const CODE = room.code;

  const st0 = await api('GET', '/api/rooms/' + CODE + '/state?playerKey=' + P1);
  checkEq('state HTTP 200', st0.status, 200);
  checkEq('开局后 room.launched=true', st0.json.room.launched, true);
  const order0 = st0.json && st0.json.series && st0.json.series.order;
  checkEq('ranked order 长度 16', order0 && order0.length, 16);
  check('ranked order 逐项 = js/draft.js 的 MODES',
    !!order0 && order0.map((s) => s.s + ':' + s.a).join(',') === EXPECTED.ranked.join(','),
    order0 && order0.map((s) => s.s + ':' + s.a).join(','));
  checkEq('ranked 首手 nextAction = 蓝方 ban',
    st0.json && JSON.stringify(st0.json.game.nextAction && { side: st0.json.game.nextAction.side, action: st0.json.game.nextAction.action }),
    JSON.stringify({ side: 'blue', action: 'ban' }));

  /* kpl / peak 蓝图镜像独立验证（各建一个房，只看 order；不需要开局） */
  for (const mode of ['kpl', 'peak']) {
    const r = await newRoom({ name: '自检-' + mode, mode, seriesCount: 1, nickname: '房主', playerKey: P1 }, { autoLaunch: false });
    const code = r.code;
    const st = await api('GET', '/api/rooms/' + code + '/state');
    const ord = st.json && st.json.series && st.json.series.order;
    checkEq(mode + ' order 长度 ' + EXPECTED[mode].length, ord && ord.length, EXPECTED[mode].length);
    check(mode + ' order 逐项 = js/draft.js 的 MODES',
      !!ord && ord.map((s) => s.s + ':' + s.a).join(',') === EXPECTED[mode].join(','),
      ord && ord.map((s) => s.s + ':' + s.a).join(','));
    if (mode === 'kpl') {
      /* 阶段边界（对应客户端引擎的断言）：蓝B1 红B1 蓝B1 红B1 → 蓝P1 红P2 蓝P2 红P1
         → 红B1 蓝B1 红B1 蓝B1 → 红P1 蓝P2 红P1 */
      const r1ban = ord.slice(0, 4);
      const r1pick = ord.slice(4, 10);
      const r2ban = ord.slice(10, 14);
      const r2pick = ord.slice(14);
      const cnt = (arr, side, act) => arr.filter((s) => s.s === side && s.a === act).length;
      checkEq('kpl 第一轮禁用 4 ban', r1ban.length, 4);
      checkEq('kpl 第一轮禁用对半（蓝2红2）',
        cnt(r1ban, 'blue', 'ban') + ',' + cnt(r1ban, 'red', 'ban'), '2,2');
      checkEq('kpl 第一轮禁用先手方 = 蓝', r1ban[0].s, 'blue');
      checkEq('kpl 第一轮选择 6 pick 且先手方 = 蓝', r1pick.length + '@' + r1pick[0].s, '6@blue');
      checkEq('kpl 第一轮选择是 蓝P1 红P2 蓝P2 红P1',
        r1pick.map((s) => (s.s === 'blue' ? 'B' : 'R')).join(''), 'BRRBBR');
      checkEq('kpl 第二轮禁用 4 ban 且先手方 = 红', r2ban.length + '@' + r2ban[0].s, '4@red');
      checkEq('kpl 第二轮禁用是 红B1 蓝B1 红B1 蓝B1',
        r2ban.map((s) => (s.s === 'blue' ? 'B' : 'R')).join(''), 'RBRB');
      checkEq('kpl 第二轮选择 4 pick 且先手方 = 红', r2pick.length + '@' + r2pick[0].s, '4@red');
      checkEq('kpl 第二轮选择是 红P1 蓝P2 红P1',
        r2pick.map((s) => (s.s === 'blue' ? 'B' : 'R')).join(''), 'RBBR');
      checkEq('kpl 合计 8 ban + 10 pick',
        ord.filter((s) => s.a === 'ban').length + '+' + ord.filter((s) => s.a === 'pick').length, '8+10');
      checkEq('kpl 每队 4 ban + 5 pick（双方对称）',
        [cnt(ord, 'blue', 'ban'), cnt(ord, 'red', 'ban'), cnt(ord, 'blue', 'pick'), cnt(ord, 'red', 'pick')].join(','),
        '4,4,5,5');
    }
    if (mode === 'peak') {
      check('peak 首项为 {s:"both",a:"ban",n:3}', !!ord && ord[0].s === 'both' && ord[0].a === 'ban' && ord[0].n === 3,
        JSON.stringify(ord && ord[0]));
      checkEq('peak 蓝图总手数 16（6 ban + 10 pick）',
        st.json && st.json.game && st.json.game.stepActions, 6);
    }
  }

  /* ---------- 4. 入房（auto / 重连 / 指定 slot / 满员） ---------- */
  group('4. 入房规则（契约 §3.2）');
  const joinP2 = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '红方', playerKey: P2, team: 'auto' });
  checkEq('team=auto 进人少的一队 → red:0',
    joinP2.json && joinP2.json.me && joinP2.json.me.team + ':' + joinP2.json.me.slot, 'red:0');

  const rejoin = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '房主改名', playerKey: P1, team: 'red' });
  checkEq('重连 HTTP 200', rejoin.status, 200);
  checkEq('重连保持原席位 blue:0',
    rejoin.json && rejoin.json.me && rejoin.json.me.team + ':' + rejoin.json.me.slot, 'blue:0');
  const stR = await api('GET', '/api/rooms/' + CODE + '/state');
  const meR = stR.json.players.find((p) => p.nickname === '房主改名');
  check('重连更新昵称', !!meR);
  checkEq('重连后不新增成员', stR.json.players.length, 2);

  const slotTaken = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '抢座', playerKey: P3, team: 'blue', slot: 0 });
  checkEq('指定已占 slot → 409', slotTaken.status, 409);
  checkEq('指定已占 slot → ERR_SLOT_TAKEN', slotTaken.json && slotTaken.json.code, 'ERR_SLOT_TAKEN');

  const j3 = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '蓝2', playerKey: P3, team: 'blue', slot: 1 });
  checkEq('指定空 slot 入房 → blue:1', j3.json && j3.json.me && j3.json.me.team + ':' + j3.json.me.slot, 'blue:1');
  await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '蓝3', playerKey: P4, team: 'blue' });
  await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '蓝4', playerKey: P5, team: 'blue' });
  await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '蓝5', playerKey: P6, team: 'blue' });
  const stFull = await api('GET', '/api/rooms/' + CODE + '/state');
  checkEq('蓝方已满 5 人', stFull.json.players.filter((p) => p.team === 'blue').length, 5);

  const P7 = 'verify-p7-' + Date.now();
  const teamFull = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '第六人', playerKey: P7, team: 'blue' });
  checkEq('满员入房 → 409', teamFull.status, 409);
  checkEq('满员入房 → ERR_TEAM_FULL', teamFull.json && teamFull.json.code, 'ERR_TEAM_FULL');
  const autoFull = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '自动位', playerKey: P7, team: 'auto' });
  checkEq('team=auto 时自动去另一队（红方仍空）', autoFull.json && autoFull.json.me && autoFull.json.me.team, 'red');
  const badSlot = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '越界', playerKey: P7, team: 'blue', slot: 5 });
  checkEq('slot 越界 → 400', badSlot.status, 400);
  const badTeam = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '越界', playerKey: P7, team: 'green' });
  checkEq('team 非法 → 400', badTeam.status, 400);

  /* ---------- 5. 房间列表 ---------- */
  group('5. 房间列表（契约 §3）');
  const list = await api('GET', '/api/rooms');
  checkEq('列表 HTTP 200', list.status, 200);
  const st404 = await api('GET', '/api/rooms/ZZZZZZ/state');
  checkEq('房间不存在 → 404', st404.status, 404);
  checkEq('房间不存在 → ERR_ROOM_NOT_FOUND', st404.json && st404.json.code, 'ERR_ROOM_NOT_FOUND');
  const mine = list.json.rooms.find((r) => r.code === CODE);
  check('列表里能找到刚建的房', !!mine);
  checkEq('列表 players = 人数(number)', mine && typeof mine.players, 'number');
  checkEq('列表 players 数值正确', mine && mine.players, 7);
  check('列表按 updated_at 倒序', (() => {
    const ts = list.json.rooms.map((r) => new Date(r.updatedAt).getTime());
    for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) return false;
    return true;
  })());

  /* ---------- 6. SSE ---------- */
  group('6. SSE 事件流（契约 §5）');
  const sse = openSse(CODE, P2);
  const hello = await sse.waitFor('hello', 5000);
  check('收到 hello 事件', !!hello);
  check('hello.data.serverTime 是 ISO 时间', !!(hello && hello.data && /^\d{4}-\d{2}-\d{2}T/.test(hello.data.serverTime)));
  check('Content-Type: text/event-stream', /text\/event-stream/.test(String(sse.headers() && sse.headers()['content-type'])));
  const sseState = await sse.waitFor('state', 5000);
  check('连接后立即补一条 state', !!sseState);
  check('state 里带 me（按连接个性化）', !!(sseState && sseState.data && sseState.data.me && sseState.data.me.team === 'red'));
  check('state.players 里有 isMe', !!(sseState && sseState.data.players.some((p) => p.isMe === true)));

  /* 有人入房 → presence 广播（真实断言，不是占位） */
  const P8 = 'verify-p8-' + Date.now();
  await api('POST', '/api/rooms/' + CODE + '/join', { nickname: '后加入', playerKey: P8, team: 'red' });
  const presence = await sse.waitFor('presence', 5000);
  check('有人入房 → 广播 presence', !!presence);
  check('presence.players 是数组且带 isMe/online',
    !!(presence && presence.data && Array.isArray(presence.data.players) &&
      presence.data.players.every((p) => typeof p.isMe === 'boolean' && typeof p.online === 'boolean')));
  check('入房后 state 再次广播（人数 +1）',
    await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const hit = sse.events.filter((e) => e.event === 'state').pop();
        if (hit && hit.data && hit.data.players && hit.data.players.length === 8) return true;
        await sleep(60);
      }
      return false;
    })());

  if (OPT.ping) {
    console.log('    （等待最多 25 秒验证 20 秒心跳 ping…）');
    const ping = await sse.waitFor('ping', 25000);
    check('收到 ping 事件（20 秒心跳）', !!ping);
  }

  /* ---------- 7. 服务端权威校验（契约 §4.1） ---------- */
  group('7. 动作校验（服务端权威，契约 §4.1）');
  const H1 = heroIds ? heroIds[0] : 105;
  const H2 = heroIds ? heroIds[1] : 106;
  const H3 = heroIds ? heroIds[2] : 107;
  const H4 = heroIds ? heroIds[3] : 108;

  const outsider = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'blue', action: 'ban', heroId: H1 }, OUT);
  checkEq('房间外的人落子 → 403', outsider.status, 403);
  checkEq('房间外的人落子 → ERR_NOT_IN_ROOM', outsider.json && outsider.json.code, 'ERR_NOT_IN_ROOM');

  const wrongTurn = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'red', action: 'ban', heroId: H1 }, P2);
  checkEq('轮次不对 → 409', wrongTurn.status, 409);
  checkEq('轮次不对 → ERR_NOT_YOUR_TURN', wrongTurn.json && wrongTurn.json.code, 'ERR_NOT_YOUR_TURN');

  const wrongAction = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'blue', action: 'pick', heroId: H1 }, P1);
  checkEq('动作不对 → 409', wrongAction.status, 409);
  checkEq('动作不对 → ERR_WRONG_ACTION', wrongAction.json && wrongAction.json.code, 'ERR_WRONG_ACTION');

  const badSide = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'green', action: 'ban', heroId: H1 }, P1);
  checkEq('side 非法 → 400', badSide.status, 400);
  const badHero = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'blue', action: 'ban', heroId: 'abc' }, P1);
  checkEq('heroId 非法 → 400', badHero.status, 400);

  if (heroListOk) {
    const unknown = await api('POST', '/api/rooms/' + CODE + '/action',
      { side: 'blue', action: 'ban', heroId: 999999 }, P1);
    checkEq('英雄不存在 → 404', unknown.status, 404);
    checkEq('英雄不存在 → ERR_HERO_UNKNOWN', unknown.json && unknown.json.code, 'ERR_HERO_UNKNOWN');
  } else {
    console.log('    （heroList=false：跳过「英雄不存在」断言，契约 §7 允许降级）');
  }

  /* ---------- 8. 连落一整局（ranked 16 手） ---------- */
  group('8. 连落满一整局（ranked 16 手）');
  const pool = heroIds ? heroIds.slice() : Array.from({ length: 40 }, (_, i) => 105 + i);
  let taken = [];
  let firstAction = null;
  let lastGame = null;
  let stepOk = true;
  let stepDetail = '';

  for (let i = 0; i < 16; i++) {
    const st = await api('GET', '/api/rooms/' + CODE + '/state');
    const game = st.json.game;
    if (!game.nextAction || game.done) { stepOk = false; stepDetail = '第 ' + (i + 1) + ' 手时 nextAction 为空'; break; }
    const expect = EXPECTED.ranked[i].split(':');
    if (game.nextAction.side !== expect[0] || game.nextAction.action !== expect[1]) {
      stepOk = false;
      stepDetail = '第 ' + (i + 1) + " 手期望 " + EXPECTED.ranked[i] + '，实际 ' + game.nextAction.side + ':' + game.nextAction.action;
      break;
    }
    if (game.stepIndex !== i) {
      stepOk = false;
      stepDetail = '第 ' + (i + 1) + ' 手前 stepIndex 期望 ' + i + '，实际 ' + game.stepIndex;
      break;
    }
    const hero = pool.find((h) => !taken.includes(h));
    const r = await api('POST', '/api/rooms/' + CODE + '/action',
      { side: expect[0], action: expect[1], heroId: hero }, i % 2 === 0 ? P1 : P2);
    if (!r.json || !r.json.ok) {
      stepOk = false;
      stepDetail = '第 ' + (i + 1) + ' 手落子失败：' + (r.json ? r.json.code + ' ' + r.json.error : r.status);
      break;
    }
    taken.push(hero);
    if (!firstAction) firstAction = r.json.action;
    lastGame = r.json.game;

    /* 第 2 手时补两个负例：重复英雄 / 再来一手越权 */
    if (i === 0) {
      const dup = await api('POST', '/api/rooms/' + CODE + '/action',
        { side: EXPECTED.ranked[1].split(':')[0], action: 'ban', heroId: hero }, P1);
      checkEq('重复英雄 → 409', dup.status, 409);
      checkEq('重复英雄 → ERR_HERO_TAKEN', dup.json && dup.json.code, 'ERR_HERO_TAKEN');
    }
  }
  check('16 手全部按蓝图顺序落满', stepOk, stepDetail);
  checkEq('game.done = true', lastGame && lastGame.done, true);
  checkEq('game.stepIndex = 16', lastGame && lastGame.stepIndex, 16);
  checkEq('蓝方 3 ban', lastGame && lastGame.bans.blue.length, 3);
  checkEq('红方 3 ban', lastGame && lastGame.bans.red.length, 3);
  checkEq('蓝方 5 pick', lastGame && lastGame.picks.blue.length, 5);
  checkEq('红方 5 pick', lastGame && lastGame.picks.red.length, 5);

  const stAfter = await api('GET', '/api/rooms/' + CODE + '/state');
  checkEq('actions 共 16 条', stAfter.json.actions.length, 16);
  checkEq('首手 seq=1', stAfter.json.actions[0].seq, 1);
  checkEq('末手 seq=16', stAfter.json.actions[15].seq, 16);
  check('每手都带 heroName', stAfter.json.actions.every((a) => typeof a.heroName === 'string' && a.heroName.length > 0));
  check('每手都带 nickname（谁落的子）', stAfter.json.actions.every((a) => !!a.nickname));

  group('9. gapMs（服务端计算，契约 §2）');
  const gaps = stAfter.json.actions.map((a) => a.gapMs);
  check('所有 gapMs ≥ 0 且为整数', gaps.every((g) => Number.isInteger(g) && g >= 0), JSON.stringify(gaps.slice(0, 5)));
  const startedAt = new Date(stAfter.json.game.startedAt).getTime();
  const firstGap = gaps[0];
  check('首手 gapMs = 距开局（与 startedAt 相差 <8 秒）',
    Math.abs(firstGap - (new Date(stAfter.json.actions[0].actedAt).getTime() - startedAt)) < 8000,
    '首手 gapMs=' + firstGap);
  check('首手 gapMs 合理（>=0，且不超过本次自检耗时）', firstGap >= 0 && firstGap < 120000, '首手 gapMs=' + firstGap);

  /* ---------- 10. 撤销 ---------- */
  group('10. 撤销');
  const undo = await api('POST', '/api/rooms/' + CODE + '/undo', {}, P1);
  checkEq('撤销 HTTP 200', undo.status, 200);
  check('返回 removed（被撤销的那一手）', !!(undo.json && undo.json.removed && undo.json.removed.seq === 16));
  const stUndo = await api('GET', '/api/rooms/' + CODE + '/state');
  checkEq('撤销后剩 15 手', stUndo.json.actions.length, 15);
  checkEq('撤销后 stepIndex 回到 15', stUndo.json.game.stepIndex, 15);
  const redo = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'red', action: 'pick', heroId: taken[15] }, P2);
  checkEq('撤销后可重落同一手', redo.json && redo.json.ok, true);
  const undoEmptyRoom = await api('POST', '/api/rooms/' + CODE + '/undo', {}, OUT);
  checkEq('越权撤销 → 403', undoEmptyRoom.status, 403);

  /* ---------- 11. SSE 收齐三类事件 ---------- */
  group('11. SSE 三类事件（hello / state / action）');
  const sseAct = await sse.waitFor('action', 5000);
  check('收到 action 事件', !!sseAct);
  check('action.data 含 action + game',
    !!(sseAct && sseAct.data && sseAct.data.action && sseAct.data.game && sseAct.data.game.stepIndex >= 0));
  check('收到重复的 state（变更后广播）', sse.count('state') >= 2, 'state 次数=' + sse.count('state'));
  check('SSE 期间累计收到 presence 事件', sse.count('presence') >= 1, 'presence 次数=' + sse.count('presence'));

  /* ---------- 12. 换局 ---------- */
  group('12. 换局（next-game）与历史');
  const badWinner = await api('POST', '/api/rooms/' + CODE + '/next-game', { winner: 'purple' }, P1);
  checkEq('winner 非法 → 400', badWinner.status, 400);
  const next = await api('POST', '/api/rooms/' + CODE + '/next-game', { winner: 'blue' }, P1);
  checkEq('换局 HTTP 200', next.status, 200);
  checkEq('新一局 gameNo=2', next.json && next.json.game && next.json.game.gameNo, 2);
  checkEq('新一局状态 drafting', next.json && next.json.game.status, 'drafting');
  checkEq('新一局从 0 手开始', next.json && next.json.game.stepIndex, 0);
  const sseGame = await sse.waitFor('game', 5000);
  check('收到 game 事件', !!sseGame);

  const history = await api('GET', '/api/rooms/' + CODE + '/history');
  checkEq('历史列表 HTTP 200', history.status, 200);
  checkEq('历史有 2 局', history.json.games.length, 2);
  const g1 = history.json.games.find((g) => g.gameNo === 1);
  const g2 = history.json.games.find((g) => g.gameNo === 2);
  checkEq('第 1 局 status=done', g1 && g1.status, 'done');
  checkEq('第 1 局 winner=blue', g1 && g1.winner, 'blue');
  checkEq('第 1 局 actionCount=16', g1 && g1.actionCount, 16);
  check('第 1 局有 finishedAt', !!(g1 && g1.finishedAt));
  checkEq('第 2 局 status=drafting', g2 && g2.status, 'drafting');
  /* 列表项自带阵容（历史卡片直接显示双方阵容头像，无需再拉 replay） */
  checkEq('历史列表项带 picks（蓝/红各 5）',
    g1 && g1.picks && g1.picks.blue.length + '/' + g1.picks.red.length, '5/5');
  checkEq('历史列表项带 bans（蓝/红各 3）',
    g1 && g1.bans && g1.bans.blue.length + '/' + g1.bans.red.length, '3/3');
  check('未开打的局也有空 picks 结构（不 undefined）',
    !!(g2 && g2.picks && Array.isArray(g2.picks.blue) && g2.picks.blue.length === 0));
  check('picks 里是 heroId（数字）',
    !!(g1 && g1.picks.blue.every((h) => Number.isInteger(h))));

  /* ---------- 13. 回放 ---------- */
  group('13. 回放（契约 §3 / §10）');
  const replay = await api('GET', '/api/games/' + g1.id + '/replay');
  checkEq('回放 HTTP 200', replay.status, 200);
  checkEq('回放 actions 16 条', replay.json.actions.length, 16);
  checkEq('回放 order 16 项', replay.json.order.length, 16);
  checkEq('回放 game.id 对得上', replay.json.game.id, g1.id);
  check('回放 gapMs 全部 ≥ 0', replay.json.actions.every((a) => Number.isInteger(a.gapMs) && a.gapMs >= 0));
  check('回放 seq 连续 1..16', replay.json.actions.every((a, i) => a.seq === i + 1));
  check('回放带 heroName', replay.json.actions.every((a) => !!a.heroName));
  check('回放首手 gapMs = 距开局（>=0 且与 actedAt-startedAt 一致）',
    replay.json.actions[0].gapMs >= 0 &&
    Math.abs(replay.json.actions[0].gapMs -
      (new Date(replay.json.actions[0].actedAt).getTime() - new Date(replay.json.game.startedAt).getTime())) < 8000,
    '首手 gapMs=' + replay.json.actions[0].gapMs);
  check('回放 order 与 state 一致',
    replay.json.order.map((s) => s.s + ':' + s.a).join(',') === EXPECTED.ranked.join(','));

  const recent = await api('GET', '/api/games/recent');
  checkEq('最近对局 HTTP 200', recent.status, 200);
  check('最近对局里能找到这一局', recent.json.games.some((g) => g.id === g1.id));
  check('最近对局 ≤ 30 条', recent.json.games.length <= 30);
  const recentGame = recent.json.games.find((g) => g.id === g1.id);
  check('最近对局项带 picks（5+5）',
    !!recentGame && recentGame.picks.blue.length === 5 && recentGame.picks.red.length === 5,
    recentGame && JSON.stringify(recentGame.picks));
  checkEq('最近对局项 actionCount 与 picks 自洽',
    !!recentGame && recentGame.actionCount, 16);

  const replay404 = await api('GET', '/api/games/99999999/replay');
  checkEq('不存在的对局 → 404', replay404.status, 404);

  /* ---------- 14. 结束整个系列 ---------- */
  group('14. 整场结束');
  const finish = await api('POST', '/api/rooms/' + CODE + '/finish', {}, P1);
  checkEq('finish HTTP 200', finish.status, 200);
  const stFin = await api('GET', '/api/rooms/' + CODE + '/state');
  checkEq('房间 status=finished', stFin.json.room.status, 'finished');
  const actAfterFin = await api('POST', '/api/rooms/' + CODE + '/action',
    { side: 'blue', action: 'ban', heroId: pool[30] }, P1);
  checkEq('结束后再落子 → 409', actAfterFin.status, 409);
  const joinAfterFin = await api('POST', '/api/rooms/' + CODE + '/join', { nickname: 'x', playerKey: 'verify-late-' + Date.now(), team: 'auto' });
  checkEq('结束后的房间不能再入房 → 409', joinAfterFin.status, 409);

  /* ---------- 15. BO1：next-game 直接结束整场 ---------- */
  group('15. BO1 换局即整场结束');
  const bo1Room = await newRoom({ name: 'BO1', mode: 'ranked', seriesCount: 1, nickname: 'BO1房主', playerKey: P1 });
  const bo1 = bo1Room.res;
  const bo1Code = bo1.json.room.code;
  const bo1Undo = await api('POST', '/api/rooms/' + bo1Code + '/undo', {}, P1);
  checkEq('没落子就撤销 → 409', bo1Undo.status, 409);
  checkEq('没落子就撤销 → ERR_NOTHING_TO_UNDO', bo1Undo.json && bo1Undo.json.code, 'ERR_NOTHING_TO_UNDO');
  const bo1Next = await api('POST', '/api/rooms/' + bo1Code + '/next-game', { winner: 'red' }, P1);
  checkEq('BO1 next-game HTTP 200', bo1Next.status, 200);
  const bo1State = await api('GET', '/api/rooms/' + bo1Code + '/state');
  checkEq('BO1 后房间 finished', bo1State.json.room.status, 'finished');
  const bo1Again = await api('POST', '/api/rooms/' + bo1Code + '/next-game', {}, P1);
  checkEq('已结束的系列不能再换局 → 409', bo1Again.status, 409);

  /* ---------- 16. 随机征召 ---------- */
  group('16. 随机征召洗牌（契约 §6）');
  const rndRoom = await newRoom({ name: '随机', mode: 'random', seriesCount: 1, nickname: '随机房主', playerKey: P1 });
  const rnd = rndRoom.res;
  const rndCode = rnd.json.room.code;
  await api('POST', '/api/rooms/' + rndCode + '/join', { nickname: '红方', playerKey: P2, team: 'red' });
  const rndState = await api('GET', '/api/rooms/' + rndCode + '/state');
  const rOrder = rndState.json.series.order;

  function orderFacts(order) {
    const bans = order.filter((s) => s.a === 'ban');
    const picks = order.filter((s) => s.a === 'pick');
    const count = (arr, side) => arr.filter((s) => s.s === side).length;
    let maxRun = 1;
    let run = 1;
    for (let i = 1; i < order.length; i++) {
      if (order[i].s === order[i - 1].s) { run += 1; maxRun = Math.max(maxRun, run); } else { run = 1; }
    }
    return {
      total: order.length,
      banTotal: bans.length, pickTotal: picks.length,
      banBlue: count(bans, 'blue'), banRed: count(bans, 'red'),
      pickBlue: count(picks, 'blue'), pickRed: count(picks, 'red'),
      firstPickSide: picks.length ? picks[0].s : null,
      banFirstSide: bans.length ? bans[0].s : null,
      banMaxRun: (() => { let r = 1, m = 1; for (let i = 1; i < bans.length; i++) { if (bans[i].s === bans[i - 1].s) { r += 1; m = Math.max(m, r); } else r = 1; } return m; })(),
      pickMaxRun: (() => { let r = 1, m = 1; for (let i = 1; i < picks.length; i++) { if (picks[i].s === picks[i - 1].s) { r += 1; m = Math.max(m, r); } else r = 1; } return m; })(),
      maxRun
    };
  }

  const f0 = orderFacts(rOrder);
  checkEq('随机 order 共 16 手', f0.total, 16);
  checkEq('ban 6 个', f0.banTotal, 6);
  checkEq('pick 10 个', f0.pickTotal, 10);
  checkEq('蓝 3 ban / 红 3 ban', f0.banBlue + '/' + f0.banRed, '3/3');
  checkEq('蓝 5 pick / 红 5 pick', f0.pickBlue + '/' + f0.pickRed, '5/5');
  checkEq('ban 段在前（前 6 项都是 ban）', rOrder.slice(0, 6).every((s) => s.a === 'ban'), true);
  checkEq('pick 段仍由蓝方先手', f0.firstPickSide, 'blue');
  check('同队不连续 3 手以上（ban 段）', f0.banMaxRun <= 2, 'ban 段最长连击=' + f0.banMaxRun);
  check('同队不连续 3 手以上（pick 段）', f0.pickMaxRun <= 2, 'pick 段最长连击=' + f0.pickMaxRun);

  const reshuffle = await api('POST', '/api/rooms/' + rndCode + '/shuffle', {}, P1);
  checkEq('重洗 HTTP 200', reshuffle.status, 200);
  const f1 = orderFacts(reshuffle.json.order);
  check('重洗后仍满足全部约束',
    f1.total === 16 && f1.banBlue === 3 && f1.banRed === 3 && f1.pickBlue === 5 && f1.pickRed === 5 &&
    f1.firstPickSide === 'blue' && f1.banMaxRun <= 2 && f1.pickMaxRun <= 2,
    JSON.stringify(f1));

  const rndFirst = reshuffle.json.order[0];
  await api('POST', '/api/rooms/' + rndCode + '/action',
    { side: rndFirst.s, action: rndFirst.a, heroId: pool[35] }, P1);
  const shuffleLate = await api('POST', '/api/rooms/' + rndCode + '/shuffle', {}, P1);
  checkEq('落子后重洗 → 409', shuffleLate.status, 409);
  checkEq('落子后重洗 → ERR_ALREADY_STARTED', shuffleLate.json && shuffleLate.json.code, 'ERR_ALREADY_STARTED');
  const shuffleRanked = await api('POST', '/api/rooms/' + bo1Code + '/shuffle', {}, P1);
  checkEq('非 random 房重洗 → 409', shuffleRanked.status, 409);

  /* ---------- 17. 巅峰赛 'both' 步语义 ---------- */
  group('17. 巅峰赛 both 步（一步吃 6 手）');
  const peakRoom = await newRoom({ name: '巅峰', mode: 'peak', seriesCount: 1, nickname: '巅峰房主', playerKey: P1 });
  const peak = peakRoom.res;
  const peakCode = peak.json.room.code;
  await api('POST', '/api/rooms/' + peakCode + '/join', { nickname: '红方', playerKey: P2, team: 'red' });

  /* 先落 5 手（蓝3 红2）：蓝方配额已用满，但本步仍需红方第 3 手才推进 */
  let peakOk = true;
  let peakDetail = '';
  const used = [];
  for (let i = 0; i < 5; i++) {
    const st = await api('GET', '/api/rooms/' + peakCode + '/state');
    const na = st.json.game.nextAction;
    if (!na || na.side !== 'both' || na.action !== 'ban') { peakOk = false; peakDetail = '第 ' + (i + 1) + ' 手 nextAction=' + JSON.stringify(na); break; }
    const hero = pool.find((h) => !used.includes(h));
    const side = i % 2 === 0 ? 'blue' : 'red';
    const r = await api('POST', '/api/rooms/' + peakCode + '/action', { side, action: 'ban', heroId: hero }, side === 'blue' ? P1 : P2);
    if (!r.json || !r.json.ok) { peakOk = false; peakDetail = '第 ' + (i + 1) + ' 手失败：' + JSON.stringify(r.json); break; }
    used.push(hero);
  }
  check('both 步里双方各 3 手都能落', peakOk, peakDetail);

  /* 蓝方 3 手已满、本步还没结束 → 第 4 手必须被拒（ERR_NOT_YOUR_TURN） */
  const peakOver = await api('POST', '/api/rooms/' + peakCode + '/action', { side: 'blue', action: 'ban', heroId: pool[10] }, P1);
  checkEq('both 步里同一方超配额 → 409', peakOver.status, 409);
  checkEq('both 步里同一方超配额 → ERR_NOT_YOUR_TURN', peakOver.json && peakOver.json.code, 'ERR_NOT_YOUR_TURN');

  /* 红方补上第 3 手 → 本步完成，进入 pick 段 */
  const peakLast = pool.find((h) => !used.includes(h));
  const r6 = await api('POST', '/api/rooms/' + peakCode + '/action', { side: 'red', action: 'ban', heroId: peakLast }, P2);
  checkEq('红方第 3 手落定 → 本步完成', r6.json && r6.json.ok, true);
  if (r6.json && r6.json.ok) used.push(peakLast);

  const peakMid = await api('GET', '/api/rooms/' + peakCode + '/state');
  checkEq('6 手后 stepIndex=1（进入 pick 段）', peakMid.json.game.stepIndex, 1);
  checkEq('6 手后蓝方 3 ban', peakMid.json.game.bans.blue.length, 3);
  checkEq('6 手后红方 3 ban', peakMid.json.game.bans.red.length, 3);
  checkEq('6 手后 nextAction 变成蓝方 pick',
    peakMid.json.game.nextAction && peakMid.json.game.nextAction.side + ':' + peakMid.json.game.nextAction.action,
    'blue:pick');

  let peakPicks = 0;
  for (let i = 0; i < 10; i++) {
    const st = await api('GET', '/api/rooms/' + peakCode + '/state');
    const na = st.json.game.nextAction;
    if (!na || na.action !== 'pick') break;
    const hero = pool.find((h) => !used.includes(h));
    const r = await api('POST', '/api/rooms/' + peakCode + '/action', { side: na.side, action: 'pick', heroId: hero }, na.side === 'blue' ? P1 : P2);
    if (!r.json || !r.json.ok) break;
    used.push(hero);
    peakPicks += 1;
  }
  checkEq('巅峰赛共能落满 16 手（6 ban + 10 pick）', peakPicks, 10);
  const peakEnd = await api('GET', '/api/rooms/' + peakCode + '/state');
  checkEq('巅峰赛 done=true', peakEnd.json.game.done, true);
  checkEq('巅峰赛 stepIndex=11（蓝图步数）', peakEnd.json.game.stepIndex, 11);
  checkEq('巅峰赛 actions=16（手数）', peakEnd.json.actions.length, 16);

  /* ---------- 18. 全局 BP 池（kpl 单边限制） ---------- */
  group('18. 全局 BP 池（kpl 单边限制）');
  const gpRoom = await newRoom({ name: '全局BP', mode: 'kpl', seriesCount: 2, nickname: '全局房主', playerKey: P1 });
  const gp = gpRoom.res;
  const gpCode = gp.json.room.code;
  await api('POST', '/api/rooms/' + gpCode + '/join', { nickname: '红方', playerKey: P2, team: 'red' });

  /* 新房：global=true，池子是空的（新系列赛清空） */
  const gp0 = await api('GET', '/api/rooms/' + gpCode + '/state');
  checkEq('kpl 房 game.global === true', gp0.json.game.global, true);
  check('新房 globalUsed 为空（开新房/换系列赛清空）',
    gp0.json.game.globalUsed.blue.length === 0 && gp0.json.game.globalUsed.red.length === 0,
    JSON.stringify(gp0.json.game.globalUsed));
  const rndStateNoGlobal = await api('GET', '/api/rooms/' + rndCode + '/state');
  check('ranked / peak / random 不启用全局 BP',
    rndStateNoGlobal.json.game.global === false &&
    st0.json.game.global === false &&
    peakEnd.json.game.global === false);

  /* 第一局：按新蓝图落前 8 手（4 ban + 4 pick），顺便验证 kpl 镜像顺序 */
  const gpUsed = [];
  const gpBans = { blue: [], red: [] };
  const gpPicks = { blue: [], red: [] };
  let gpOk = true;
  let gpDetail = '';
  for (let i = 0; i < 8; i++) {
    const st = await api('GET', '/api/rooms/' + gpCode + '/state');
    const na = st.json.game.nextAction;
    const expect = EXPECTED.kpl[i].split(':');
    if (!na || na.side !== expect[0] || na.action !== expect[1]) {
      gpOk = false;
      gpDetail = '第 ' + (i + 1) + ' 手期望 ' + EXPECTED.kpl[i] + '，实际 ' + JSON.stringify(na);
      break;
    }
    const hero = pool.find((h) => !gpUsed.includes(h));
    const r = await api('POST', '/api/rooms/' + gpCode + '/action',
      { side: expect[0], action: expect[1], heroId: hero }, expect[0] === 'blue' ? P1 : P2);
    if (!r.json || !r.json.ok) { gpOk = false; gpDetail = '第 ' + (i + 1) + ' 手失败：' + JSON.stringify(r.json); break; }
    gpUsed.push(hero);
    (expect[1] === 'ban' ? gpBans : gpPicks)[expect[0]].push(hero);
  }
  check('kpl 第一局前 8 手按新蓝图落成', gpOk, gpDetail);
  checkEq('kpl 第一轮双方各 2 ban / 2 pick',
    [gpBans.blue.length, gpBans.red.length, gpPicks.blue.length, gpPicks.red.length].join(','), '2,2,2,2');

  const bluePick1 = gpPicks.blue[0];
  const redPick1 = gpPicks.red[0];
  const blueBan1 = gpBans.blue[0];

  const gpMid = await api('GET', '/api/rooms/' + gpCode + '/state');
  check('本局 pick 立即进入 globalUsed（跨局累计）',
    gpMid.json.game.globalUsed.blue.includes(bluePick1) && gpMid.json.game.globalUsed.red.includes(redPick1));
  check('ban 不进全局池',
    !gpMid.json.game.globalUsed.blue.includes(blueBan1) && !gpMid.json.game.globalUsed.red.includes(blueBan1));

  /* 换局：池子必须保留 */
  const gpNext = await api('POST', '/api/rooms/' + gpCode + '/next-game', { winner: 'blue' }, P1);
  checkEq('kpl 换局 HTTP 200', gpNext.status, 200);
  const gp2 = await api('GET', '/api/rooms/' + gpCode + '/state');
  checkEq('第二局 gameNo=2', gp2.json.game.gameNo, 2);
  check('换局后 globalUsed 保留第一局双方 pick（不清空）',
    gp2.json.game.globalUsed.blue.includes(bluePick1) && gp2.json.game.globalUsed.red.includes(redPick1),
    JSON.stringify(gp2.json.game.globalUsed));

  /* 第二局：先落满第一轮禁用（4 手），此时轮到第 5 手 = 蓝P1 */
  for (let i = 0; i < 4; i++) {
    const st = await api('GET', '/api/rooms/' + gpCode + '/state');
    const na = st.json.game.nextAction;
    const hero = pool.find((h) => !gpUsed.includes(h));
    const r = await api('POST', '/api/rooms/' + gpCode + '/action', { side: na.side, action: na.action, heroId: hero }, na.side === 'blue' ? P1 : P2);
    if (!r.json || !r.json.ok) break;
    gpUsed.push(hero);
  }

  /* 第 5 手 = 蓝P1：验证「上一局被 ban 过的英雄，本局仍能选」（禁用不进全局池） */
  const gpBanPick = await api('POST', '/api/rooms/' + gpCode + '/action', { side: 'blue', action: 'pick', heroId: blueBan1 }, P1);
  checkEq('上一局被 ban 过的英雄 → 本局仍可选（禁用不进池）', gpBanPick.json && gpBanPick.json.ok, true);
  if (gpBanPick.json && gpBanPick.json.ok) gpUsed.push(blueBan1);

  /* 第 6 手 = 红P1：验证「同侧选自己上一局选过的」被服务端拒掉 */
  const gpHit = await api('POST', '/api/rooms/' + gpCode + '/action', { side: 'red', action: 'pick', heroId: redPick1 }, P2);
  checkEq('同侧选自己上一局选过的英雄 → 409', gpHit.status, 409);
  checkEq('同侧重复 → ERR_HERO_GLOBAL_USED', gpHit.json && gpHit.json.code, 'ERR_HERO_GLOBAL_USED');
  check('错误提示是中文且点明全局 BP', !!(gpHit.json && /全局 BP/.test(gpHit.json.error)), gpHit.json && gpHit.json.error);

  /* 还是第 6 手（上一次被拒没消耗轮次）：验证「对方上一局选过的」允许（单边限制） */
  const gpCross = await api('POST', '/api/rooms/' + gpCode + '/action', { side: 'red', action: 'pick', heroId: bluePick1 }, P2);
  checkEq('对方上一局选过的英雄 → 允许（单边限制）', gpCross.json && gpCross.json.ok, true);
  if (gpCross.json && gpCross.json.ok) gpUsed.push(bluePick1);

  /* 第二局继续落满剩余 12 手：验证「整局 18 手」与全局池共存 */
  let gpRest = 0;
  let gpRestOk = true;
  let gpRestDetail = '';
  for (let i = 6; i < 18; i++) {
    const st = await api('GET', '/api/rooms/' + gpCode + '/state');
    const na = st.json.game.nextAction;
    const expect = EXPECTED.kpl[i].split(':');
    if (!na || na.side !== expect[0] || na.action !== expect[1]) {
      gpRestOk = false;
      gpRestDetail = '第 ' + (i + 1) + ' 手期望 ' + EXPECTED.kpl[i] + '，实际 ' + JSON.stringify(na);
      break;
    }
    const hero = pool.find((h) => !gpUsed.includes(h));
    const r = await api('POST', '/api/rooms/' + gpCode + '/action',
      { side: expect[0], action: expect[1], heroId: hero }, expect[0] === 'blue' ? P1 : P2);
    if (!r.json || !r.json.ok) { gpRestOk = false; gpRestDetail = '第 ' + (i + 1) + ' 手失败：' + JSON.stringify(r.json); break; }
    gpUsed.push(hero);
    gpRest += 1;
  }
  check('kpl 第二局剩余 12 手全部按蓝图落成', gpRestOk && gpRest === 12, gpRestDetail || ('落了 ' + gpRest + ' 手'));
  const gpEnd = await api('GET', '/api/rooms/' + gpCode + '/state');
  checkEq('kpl 单局 actions=18（整局 18 手对得上）', gpEnd.json.actions.length, 18);
  checkEq('kpl done=true 且 stepIndex=18', gpEnd.json.game.done + '/' + gpEnd.json.game.stepIndex, 'true/18');
  checkEq('kpl 双方各 4 ban / 5 pick',
    [gpEnd.json.game.bans.blue.length, gpEnd.json.game.bans.red.length,
      gpEnd.json.game.picks.blue.length, gpEnd.json.game.picks.red.length].join(','), '4,4,5,5');
  check('整局跑完后 globalUsed 仍跨局累计（双方各 ≥5）',
    gpEnd.json.game.globalUsed.blue.length >= 5 && gpEnd.json.game.globalUsed.red.length >= 5,
    'blue=' + gpEnd.json.game.globalUsed.blue.length + ' red=' + gpEnd.json.game.globalUsed.red.length);

  /* ---------- 19. 静态文件 ---------- */
  group('19. 静态文件与安全');
  const home = await request('GET', '/');
  checkEq('GET / → 200', home.status, 200);
  check('GET / → text/html', /text\/html/.test(String(home.headers['content-type'])));
  const jsFile = await request('GET', '/js/draft.js');
  checkEq('GET /js/draft.js → 200', jsFile.status, 200);
  check('js 的 MIME 正确', /javascript/.test(String(jsFile.headers['content-type'])));
  const cssFile = await request('GET', '/styles/app.css');
  check('css 请求有响应（200 或 404，不 500）', cssFile.status === 200 || cssFile.status === 404, 'status=' + cssFile.status);
  const apiNope = await request('GET', '/api/nope');
  checkEq('未知 /api 路径 → 404', apiNope.status, 404);
  check('未知 /api 路径返回 JSON', !!(apiNope.json && apiNope.json.ok === false));
  /* 路径穿越：用原始 path 发（new URL 会先把 ../ 规范化掉，测不出问题） */
  const trav1 = await rawRequest('GET', '/..%2f..%2fpackage.json');
  check('编码路径穿越(/..%2f..%2fpackage.json) → 403', trav1.status === 403, 'status=' + trav1.status);
  const trav2 = await rawRequest('GET', '/%2e%2e%5c%2e%2e%5cpackage.json');
  check('编码路径穿越(/%2e%2e%5c 反斜杠) → 403', trav2.status === 403, 'status=' + trav2.status);
  const trav3 = await rawRequest('GET', '/../../../../Windows/win.ini');
  check('多级 ../ 不会读到根目录外的文件', trav3.status === 403 || trav3.status === 404, 'status=' + trav3.status);
  /* WHATWG URL 会先把 %2e%2e 规范化掉（请求变成 /package.json，仍在网站根目录内）——
     这里断言的是「不逃出根目录」，而不是一定 403 */
  const trav4 = await rawRequest('GET', '/%2e%2e/%2e%2e/package.json');
  check('规范化后的 ../ 仍落在网站根目录内（200 且是本站文件，或 403）',
    trav4.status === 403 || (trav4.status === 200 && trav4.text.includes('"name": "wzbp"')),
    'status=' + trav4.status);
  const head = await request('HEAD', '/');
  checkEq('HEAD / → 200', head.status, 200);
  const wrongMethod = await request('DELETE', '/api/rooms');
  checkEq('错误方法 → 405', wrongMethod.status, 405);

  /* ---------- 19. 离房 ---------- */
  group('20. 离房');
  const leave = await api('POST', '/api/rooms/' + peakCode + '/leave', {}, P2);
  checkEq('离房 HTTP 200', leave.status, 200);
  checkEq('离房 removed=true', leave.json && leave.json.removed, true);
  const peakAfterLeave = await api('GET', '/api/rooms/' + peakCode + '/state');
  checkEq('离房后成员 -1', peakAfterLeave.json.players.length, 1);

  /* ---------- 21. v3：管理员账号 / 开局闸门 / 服务端权威自动计时 ---------- */
  group('21. v3 管理员账号 + 开局闸门 + 自动计时（契约 §3.0 / §3.0.1 / §6.4）');
  const V1 = 'verify-v3a-' + Date.now();
  const V2 = 'verify-v3b-' + Date.now();
  const v3Admin = adminCreds();

  /* 超时房（turnSeconds=30，最小值）：本组开始时创建，本组结束时再来验证「到 0 不代替落子」 */
  const t30Admin = adminCreds();
  const t30 = await api('POST', '/api/rooms', {
    name: '超时房', mode: 'ranked', seriesCount: 1, turnSeconds: 30,
    nickname: '超时房主', playerKey: V1,
    adminUser: t30Admin.adminUser, adminPass: t30Admin.adminPass
  });
  const T30CODE = t30.json.room.code;
  const t30LaunchAt = Date.now();
  const t30Launch = await api('POST', '/api/rooms/' + T30CODE + '/launch', { adminToken: t30.json.adminToken });
  checkEq('turnSeconds=30 的房可以开局', t30Launch.status, 200);
  checkEq('开局后 turn.seconds=30（建房配置生效）', t30Launch.json.game.turn.seconds, 30);

  const v3 = await api('POST', '/api/rooms', {
    name: 'v3流程房', mode: 'ranked', seriesCount: 2, turnSeconds: 60,
    nickname: 'v3房主', playerKey: V1,
    adminUser: v3Admin.adminUser, adminPass: v3Admin.adminPass
  });
  checkEq('建房（带管理员账号）HTTP 200', v3.status, 200);
  const V3CODE = v3.json.room.code;
  const V3TOKEN0 = v3.json.adminToken;
  check('建房返回 adminToken（32 字节 hex）', /^[0-9a-f]{64}$/.test(String(V3TOKEN0)), String(V3TOKEN0).slice(0, 12) + '…');
  checkEq('默认未开局（launched=false）', v3.json.room.launched, false);
  checkEq('room.turnSeconds=60', v3.json.room.turnSeconds, 60);
  checkEq('room.paused=false', v3.json.room.paused, false);
  check('建房返回 adminTokenExpiresAt（12 小时）', (() => {
    const t = new Date(v3.json.adminTokenExpiresAt).getTime();
    return Number.isFinite(t) && Math.abs(t - (Date.now() + 12 * 3600 * 1000)) < 60000;
  })(), v3.json.adminTokenExpiresAt);

  /* 未开局：任何落子都被拒（用户明确要求的第一步闸门） */
  const preA = await api('POST', '/api/rooms/' + V3CODE + '/action', { side: 'blue', action: 'ban', heroId: H1 }, V1);
  checkEq('未开局落子 → 409', preA.status, 409);
  checkEq('未开局落子 → ERR_NOT_LAUNCHED', preA.json && preA.json.code, 'ERR_NOT_LAUNCHED');
  check('未开局提示是中文且点明「开始 BP」', !!(preA.json && /管理员|开始 BP/.test(preA.json.error)), preA.json && preA.json.error);
  const preB = await api('POST', '/api/rooms/' + V3CODE + '/action', { side: 'blue', action: 'ban', heroId: H2 }, V2);
  checkEq('没入房的人落子 → 403 ERR_NOT_IN_ROOM（优先于开局判定）', preB.json && preB.json.code, 'ERR_NOT_IN_ROOM');
  await api('POST', '/api/rooms/' + V3CODE + '/join', { nickname: '第二人', playerKey: V2, team: 'red' });
  const preB2 = await api('POST', '/api/rooms/' + V3CODE + '/action', { side: 'blue', action: 'ban', heroId: H2 }, V2);
  checkEq('入房后未开局落子 → ERR_NOT_LAUNCHED（对所有人都一样）', preB2.json && preB2.json.code, 'ERR_NOT_LAUNCHED');
  const preO = await api('POST', '/api/rooms/' + V3CODE + '/action', { side: 'blue', action: 'ban', heroId: H1 }, OUT);
  checkEq('房间外的人仍然优先 403 ERR_NOT_IN_ROOM（不泄露开局状态）', preO.json && preO.json.code, 'ERR_NOT_IN_ROOM');

  const preState = await api('GET', '/api/rooms/' + V3CODE + '/state?playerKey=' + V1);
  checkEq('未开局 state.room.launched=false', preState.json.room.launched, false);
  checkEq('未开局 turn.deadline=null', preState.json.game.turn.deadline, null);
  checkEq('未开局 turn.remainingMs=null', preState.json.game.turn.remainingMs, null);
  checkEq('未开局 turn.seconds 照常下发（前端显示配置）', preState.json.game.turn.seconds, 60);
  checkEq('state.admin.users = 管理员账号名', JSON.stringify(preState.json.admin.users), JSON.stringify([v3Admin.adminUser]));
  checkEq('不带 adminToken 时 admin.you=false', preState.json.admin.you, false);

  /* 非管理员 launch：403 / 401 */
  const l0 = await api('POST', '/api/rooms/' + V3CODE + '/launch', {});
  checkEq('不带 adminToken 开局 → 403', l0.status, 403);
  checkEq('不带 adminToken → ERR_NOT_ADMIN', l0.json && l0.json.code, 'ERR_NOT_ADMIN');
  const l1 = await api('POST', '/api/rooms/' + V3CODE + '/launch', {}, V1);
  checkEq('只有 playerKey（普通队员）不能开局 → 403 ERR_NOT_ADMIN', l1.json && l1.json.code, 'ERR_NOT_ADMIN');
  const l2 = await api('POST', '/api/rooms/' + V3CODE + '/launch', { adminToken: 'f'.repeat(64) });
  checkEq('伪造 adminToken → 401', l2.status, 401);
  checkEq('伪造 adminToken → ERR_BAD_TOKEN', l2.json && l2.json.code, 'ERR_BAD_TOKEN');
  const otherRoom = await newRoom({ name: '别的房', mode: 'ranked', seriesCount: 1, nickname: '别人', playerKey: V2 }, { autoLaunch: false });
  const l3 = await api('POST', '/api/rooms/' + V3CODE + '/launch', { adminToken: otherRoom.token });
  checkEq('拿别的房间的 adminToken → 401', l3.status, 401);
  checkEq('跨房间 token → ERR_BAD_TOKEN', l3.json && l3.json.code, 'ERR_BAD_TOKEN');

  /* 管理员登录（账号 + 密码） */
  const lg0 = await api('POST', '/api/rooms/' + V3CODE + '/admin-login', { adminUser: v3Admin.adminUser, adminPass: 'wrong-pass-1' });
  checkEq('密码错误 → 401', lg0.status, 401);
  checkEq('密码错误 → ERR_BAD_CREDENTIALS', lg0.json && lg0.json.code, 'ERR_BAD_CREDENTIALS');
  const lgUnknown = await api('POST', '/api/rooms/' + V3CODE + '/admin-login', { adminUser: 'nobody_here', adminPass: v3Admin.adminPass });
  checkEq('账号不存在 → 401（与密码错同码）', lgUnknown.status, 401);
  checkEq('账号不存在 → ERR_BAD_CREDENTIALS（同码，防账号探测）', lgUnknown.json && lgUnknown.json.code, 'ERR_BAD_CREDENTIALS');
  checkEq('账号不存在与密码错：HTTP 码一致', lgUnknown.status, lg0.status);
  checkEq('账号不存在与密码错：code 一致', lgUnknown.json && lgUnknown.json.code, lg0.json && lg0.json.code);
  checkEq('账号不存在与密码错：error 文案逐字一致', lgUnknown.json && lgUnknown.json.error, lg0.json && lg0.json.error);
  check('登录失败文案是中文', !!(lg0.json && /管理员账号或密码/.test(lg0.json.error)), lg0.json && lg0.json.error);
  /* 格式不合法仍然 400（ERR_BAD_ADMIN_USER / ERR_BAD_ADMIN_PASS） */
  const lgFmtUser = await api('POST', '/api/rooms/' + V3CODE + '/admin-login', { adminUser: 'ab', adminPass: v3Admin.adminPass });
  checkEq('登录账号格式不合法 → 400', lgFmtUser.status, 400);
  checkEq('登录账号格式不合法 → ERR_BAD_ADMIN_USER', lgFmtUser.json && lgFmtUser.json.code, 'ERR_BAD_ADMIN_USER');
  const lgFmtPass = await api('POST', '/api/rooms/' + V3CODE + '/admin-login', { adminUser: v3Admin.adminUser, adminPass: '12345' });
  checkEq('登录密码格式不合法 → 400', lgFmtPass.status, 400);
  checkEq('登录密码格式不合法 → ERR_BAD_ADMIN_PASS', lgFmtPass.json && lgFmtPass.json.code, 'ERR_BAD_ADMIN_PASS');
  const lg = await api('POST', '/api/rooms/' + V3CODE + '/admin-login', { adminUser: v3Admin.adminUser, adminPass: v3Admin.adminPass });
  checkEq('管理员登录 HTTP 200', lg.status, 200);
  const V3TOKEN = lg.json.adminToken;
  check('登录返回 adminToken（64 位 hex）', /^[0-9a-f]{64}$/.test(String(V3TOKEN)));
  check('每次登录独立令牌（与建房时不同）', V3TOKEN !== V3TOKEN0);
  const stToken = await api('GET', '/api/rooms/' + V3CODE + '/state?playerKey=' + V1 + '&adminToken=' + V3TOKEN);
  checkEq('带 adminToken 读 state → admin.you=true', stToken.json.admin.you, true);
  const stHeader = await request('GET', '/api/rooms/' + V3CODE + '/state?playerKey=' + V1, { headers: { 'X-Admin-Token': V3TOKEN } });
  checkEq('adminToken 也能走 X-Admin-Token 请求头', stHeader.json.admin.you, true);
  const adminSse = openSse(V3CODE, V1, V3TOKEN);
  const adminSseState = await adminSse.waitFor('state', 5000);
  checkEq('SSE 的 state 也按连接算 admin.you（管理员连接=true）', adminSseState && adminSseState.data.admin.you, true);
  adminSse.close();

  /* 管理员开局 */
  const lc = await api('POST', '/api/rooms/' + V3CODE + '/launch', { adminToken: V3TOKEN });
  checkEq('管理员开局 HTTP 200', lc.status, 200);
  checkEq('开局后 room.launched=true', lc.json.room.launched, true);
  checkEq('开局后 room.status=drafting', lc.json.room.status, 'drafting');
  checkEq('开局返回 launchedBy=管理员账号', lc.json.launchedBy, v3Admin.adminUser);
  check('开局即开始第一手计时（deadline 在 0..60 秒内）', (() => {
    const dl = new Date(lc.json.game.turn.deadline).getTime();
    return Number.isFinite(dl) && dl > Date.now() - 2000 && dl <= Date.now() + 61000;
  })(), lc.json.game.turn.deadline);
  check('开局 remainingMs ∈ (0, 60000]',
    typeof lc.json.game.turn.remainingMs === 'number' && lc.json.game.turn.remainingMs > 0 && lc.json.game.turn.remainingMs <= 60000,
    String(lc.json.game.turn.remainingMs));
  const lc2 = await api('POST', '/api/rooms/' + V3CODE + '/launch', { adminToken: V3TOKEN });
  checkEq('还没落子时重复开局 → 200（只是重新计时）', lc2.status, 200);

  /* 落一手 → 计时立即重置 */
  const act1 = await api('POST', '/api/rooms/' + V3CODE + '/action', { side: 'blue', action: 'ban', heroId: H1 }, V1);
  checkEq('开局后落子 HTTP 200', act1.status, 200);
  const turn1 = act1.json.game.turn;
  checkEq('落子后 turn.seconds=60', turn1.seconds, 60);
  check('落子后 remainingMs 重置回接近 60000', turn1.remainingMs > 53000 && turn1.remainingMs <= 60000, String(turn1.remainingMs));
  check('落子后 deadline ≈ 现在 + 60 秒', Math.abs(new Date(turn1.deadline).getTime() - Date.now() - 60000) < 5000, turn1.deadline);

  /* 计时确实在走（服务端算，客户端不用自己起算） */
  const s1 = await api('GET', '/api/rooms/' + V3CODE + '/state');
  await sleep(1200);
  const s2 = await api('GET', '/api/rooms/' + V3CODE + '/state');
  const drop = s1.json.game.turn.remainingMs - s2.json.game.turn.remainingMs;
  check('1.2 秒后 remainingMs 减少约 1.2 秒（计时在走）', drop > 800 && drop < 3000, '减少了 ' + drop + 'ms');
  checkEq('同一手的 deadline 稳定（两次读一致）', s1.json.game.turn.deadline, s2.json.game.turn.deadline);

  /* 撤销也要重置计时 */
  const undoV3 = await api('POST', '/api/rooms/' + V3CODE + '/undo', {}, V1);
  checkEq('撤销 HTTP 200', undoV3.status, 200);
  check('撤销后 remainingMs 重置回接近 60000', undoV3.json.game.turn.remainingMs > 53000, String(undoV3.json.game.turn.remainingMs));

  /* 暂停 / 继续（管理员） */
  const pauseNoAuth = await api('POST', '/api/rooms/' + V3CODE + '/pause', { paused: true }, V1);
  checkEq('普通队员不能暂停 → 403 ERR_NOT_ADMIN', pauseNoAuth.json && pauseNoAuth.json.code, 'ERR_NOT_ADMIN');
  const pause = await api('POST', '/api/rooms/' + V3CODE + '/pause', { adminToken: V3TOKEN, paused: true });
  checkEq('管理员暂停 HTTP 200', pause.status, 200);
  checkEq('暂停后 room.paused=true', pause.json.room.paused, true);
  checkEq('暂停后 turn.deadline=null（契约 §6.4 规则 3）', pause.json.game.turn.deadline, null);
  const frozen = pause.json.game.turn.remainingMs;
  check('暂停后 remainingMs 保留剩余时间（>0 且 ≤60000）', frozen > 0 && frozen <= 60000, String(frozen));
  await sleep(900);
  const during = await api('GET', '/api/rooms/' + V3CODE + '/state');
  checkEq('暂停期间 remainingMs 冻结不变', during.json.game.turn.remainingMs, frozen);
  checkEq('暂停期间 room.paused=true 随 state 下发', during.json.room.paused, true);
  const resume = await api('POST', '/api/rooms/' + V3CODE + '/pause', { adminToken: V3TOKEN, paused: false });
  checkEq('继续 HTTP 200', resume.status, 200);
  checkEq('继续后 room.paused=false', resume.json.room.paused, false);
  check('继续后按剩余时间续上（不是重新 60 秒）',
    resume.json.game.turn.remainingMs <= frozen && resume.json.game.turn.remainingMs > 0,
    '续上 ' + resume.json.game.turn.remainingMs + 'ms（暂停时冻结 ' + frozen + 'ms）');
  check('继续后重新给出 deadline', !!resume.json.game.turn.deadline);
  const tog1 = await api('POST', '/api/rooms/' + V3CODE + '/pause', { adminToken: V3TOKEN });
  checkEq('pause 不传 paused = 切换成暂停', tog1.json.paused, true);
  const tog2 = await api('POST', '/api/rooms/' + V3CODE + '/pause', { adminToken: V3TOKEN });
  checkEq('再调一次 = 切回继续', tog2.json.paused, false);

  /* 换局 → 新一局计时从头开始 */
  const nextV3 = await api('POST', '/api/rooms/' + V3CODE + '/next-game', { winner: 'blue' }, V1);
  checkEq('换局 HTTP 200', nextV3.status, 200);
  checkEq('新一局 gameNo=2', nextV3.json.game.gameNo, 2);
  check('新一局 remainingMs 重置回接近 60000', nextV3.json.game.turn.remainingMs > 53000, String(nextV3.json.game.turn.remainingMs));

  /* 结束整场后不再计时 */
  const finV3 = await api('POST', '/api/rooms/' + V3CODE + '/finish', {}, V1);
  checkEq('结束系列 HTTP 200', finV3.status, 200);
  const finState = await api('GET', '/api/rooms/' + V3CODE + '/state');
  checkEq('结束后 turn.remainingMs=null', finState.json.game.turn.remainingMs, null);
  checkEq('结束后 turn.deadline=null', finState.json.game.turn.deadline, null);

  /* 到 0 不代替玩家落子：30 秒的房现在应该已经到点了 */
  const elapsed = Date.now() - t30LaunchAt;
  const need = 30500 - elapsed;
  console.log('    （验证「超时」语义：超时房已跑 ' + (elapsed / 1000).toFixed(1) + ' 秒，再等 ' +
    (need > 0 ? (need / 1000).toFixed(1) : '0') + ' 秒…）');
  if (need > 0) await sleep(need);
  const toState = await api('GET', '/api/rooms/' + T30CODE + '/state');
  checkEq('超时后 remainingMs 停在 0（不为负）', toState.json.game.turn.remainingMs, 0);
  checkEq('超时不会替玩家落子（actions 仍为 0）', toState.json.actions.length, 0);
  checkEq('超时后轮次没有被推进（仍是蓝方 ban）',
    toState.json.game.nextAction && toState.json.game.nextAction.side + ':' + toState.json.game.nextAction.action, 'blue:ban');
  check('超时后 deadline 仍在（只是已经过去）', !!toState.json.game.turn.deadline);
  const toAct = await api('POST', '/api/rooms/' + T30CODE + '/action', { side: 'blue', action: 'ban', heroId: H3 }, V1);
  check('超时后玩家仍可自己落子（服务端不锁死、也不代打）', toAct.json && toAct.json.ok === true, toAct.json && (toAct.json.code || ''));
  check('落子后计时又重置回接近 30000', toAct.json && toAct.json.game.turn.remainingMs > 26000, toAct.json && String(toAct.json.game.turn.remainingMs));

  /* ---------- 22. 密码哈希本体（scrypt） ---------- */
  group('22. 管理员密码哈希（scrypt 加盐，契约 §3.0.1）');
  const apiMod = require(path.join(ROOT, 'server', 'api.js'));
  const PLAIN = '明文密码-123456';
  const hash1 = apiMod.hashPassword(PLAIN);
  check('哈希串形如 scrypt$N$r$p$salt$hash',
    /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(hash1), hash1);
  check('哈希串里不含明文密码', hash1.indexOf(PLAIN) === -1);
  check('同一个密码两次哈希结果不同（随机盐）', apiMod.hashPassword(PLAIN) !== hash1);
  check('正确密码校验通过', apiMod.verifyPassword(PLAIN, hash1) === true);
  check('错误密码校验失败', apiMod.verifyPassword(PLAIN + 'x', hash1) === false);
  check('损坏/伪造的哈希串返回 false 而不抛异常',
    apiMod.verifyPassword('x', 'plain-text') === false &&
    apiMod.verifyPassword('x', 'scrypt$1$2$3$zz$00') === false &&
    apiMod.verifyPassword('x', '') === false);
  check('sha256(token) 是 64 位 hex', /^[0-9a-f]{64}$/.test(apiMod.sha256hex('abc')));

  /* ---------- 23. 老库幂等迁移（真库直连 + 隔离临时库） ---------- */
  group('23. 老库幂等迁移（契约 §2.1）');
  if (OPT.base) {
    console.log('    （--base 模式不知道数据库连接参数，跳过；迁移证据请用默认模式跑）');
  } else if (OPT.memory) {
    const vdb = require(path.join(ROOT, 'server', 'db.js'));
    await vdb.init();
    const m1 = vdb.migration();
    await vdb.init();
    const m2 = vdb.migration();
    check('内存驱动连续两次 init 都不抛错', true);
    checkEq('内存驱动 migration().driver=memory', m2.driver, 'memory');
    checkEq('内存驱动不需要迁移（added 为空）', m1.added.length + m2.added.length, 0);
    await vdb.close();
    console.log('    （内存驱动没有真实表结构：information_schema / 老库升级 / 库内哈希证据跳过，真库模式会跑）');
  } else {
    const vdb = require(path.join(ROOT, 'server', 'db.js'));
    const DBNAME = process.env.WZBP_DB_NAME || 'wzbp';

    /* 23.1 在**当前真库**上重复 init：不应再 ALTER，也不应报错 */
    await vdb.init();
    const m1 = vdb.migration();
    checkEq('对已迁移的库再 init 一次不新增列（added 为空）', m1.added.length, 0);
    checkEq('migration().driver=mysql', m1.driver, 'mysql');

    /* 23.2 结构断言（真库 information_schema） */
    const cols = await vdb.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
      [DBNAME, 'rooms']);
    const colNames = cols.map((c) => String(c.column_name || c.COLUMN_NAME).toLowerCase());
    for (const c of ['launched', 'turn_seconds', 'paused']) {
      check('真库 rooms 有列 ' + c, colNames.indexOf(c) >= 0, colNames.join(','));
    }
    const tabs = await vdb.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = ?', [DBNAME]);
    const tabNames = tabs.map((t) => String(t.table_name || t.TABLE_NAME).toLowerCase());
    check('真库有 room_admins 表', tabNames.indexOf('room_admins') >= 0, tabNames.join(','));
    check('真库有 admin_tokens 表', tabNames.indexOf('admin_tokens') >= 0, tabNames.join(','));
    if (logPath) {
      const migLine = (readLog().match(/\[db\] v3 迁移：[^\n]*/) || [null])[0];
      console.log('    ↳ 服务启动日志：' + (migLine || '（本次启动没有打迁移行：库已是 v3 结构 → 幂等重跑，符合预期）'));
    }

    /* 23.3 库里的密码哈希：不是明文，且服务端能校验通过 */
    const admRows = await vdb.query(
      'SELECT username, pass_hash FROM room_admins WHERE room_id = (SELECT id FROM rooms WHERE code = ?)',
      [V3CODE]);
    checkEq('真库 room_admins 里有这条管理员', admRows.length, 1);
    const storedHash = admRows.length ? String(admRows[0].pass_hash) : '';
    check('库里 pass_hash 是 scrypt 串（形如 scrypt$N$r$p$salt$hash）',
      /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(storedHash), storedHash.slice(0, 30) + '…');
    check('库里绝不存明文密码', storedHash.indexOf(v3Admin.adminPass) === -1 && storedHash !== v3Admin.adminPass);
    check('库里的哈希能被服务端校验通过（相同参数 + timingSafeEqual）',
      apiMod.verifyPassword(v3Admin.adminPass, storedHash) === true);
    check('库里的哈希对错误密码判失败', apiMod.verifyPassword(v3Admin.adminPass + 'x', storedHash) === false);
    const tokRows = await vdb.query('SELECT token_hash FROM admin_tokens WHERE room_id = (SELECT id FROM rooms WHERE code = ?)', [V3CODE]);
    check('库里只存 token 的 sha256（没有明文 token）',
      tokRows.length >= 1 && tokRows.every((r) => /^[0-9a-f]{64}$/.test(String(r.token_hash))) &&
      tokRows.every((r) => String(r.token_hash) !== V3TOKEN), '共 ' + tokRows.length + ' 条');

    /* 23.4 token 过期 → 401（直接把库里的 expires_at 改到过去） */
    await vdb.query('UPDATE admin_tokens SET expires_at = ? WHERE token_hash = ?',
      [new Date(Date.now() - 5000), apiMod.sha256hex(V3TOKEN)]);
    const expired = await api('POST', '/api/rooms/' + V3CODE + '/pause', { adminToken: V3TOKEN });
    checkEq('已过期的 token → 401', expired.status, 401);
    checkEq('已过期的 token → ERR_BAD_TOKEN', expired.json && expired.json.code, 'ERR_BAD_TOKEN');
    const stExpired = await api('GET', '/api/rooms/' + V3CODE + '/state?adminToken=' + V3TOKEN);
    checkEq('过期后 state.admin.you=false', stExpired.json.admin.you, false);

    /* 23.5 admin-logout 立刻作废令牌 */
    const logout = await api('POST', '/api/rooms/' + V3CODE + '/admin-logout', { adminToken: V3TOKEN0 });
    checkEq('管理员退出 HTTP 200', logout.status, 200);
    const afterLogout = await api('POST', '/api/rooms/' + V3CODE + '/launch', { adminToken: V3TOKEN0 });
    checkEq('退出后的 token 立刻失效 → 401', afterLogout.status, 401);
    checkEq('退出后 ERR_BAD_TOKEN', afterLogout.json && afterLogout.json.code, 'ERR_BAD_TOKEN');

    /* 23.6 隔离临时库上完整跑一遍「v2 老库 → v3」升级 + 再跑一次（幂等） */
    const tmpDb = 'wzbp_mig_' + Date.now().toString(36);
    const legacyCode = ('LEG' + Date.now().toString(36).slice(-3)).toUpperCase();
    const quietCode = ('OLD' + Date.now().toString(36).slice(-3)).toUpperCase();
    const tmpScript = path.join(os.tmpdir(), 'wzbp-mig-check-' + Date.now() + '.js');
    const tmpOut = path.join(os.tmpdir(), 'wzbp-mig-out-' + Date.now() + '.log');
    let childOut = '';
    try {
      /* 造一个「v2 表结构 + 数据」的库：rooms 没有 launched/turn_seconds/paused */
      await vdb.query('CREATE DATABASE IF NOT EXISTS `' + tmpDb + '` DEFAULT CHARACTER SET utf8mb4');
      await vdb.query('CREATE TABLE `' + tmpDb + '`.`rooms` (' +
        'id BIGINT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(12) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL DEFAULT \'\',' +
        'mode VARCHAR(24) NOT NULL DEFAULT \'ranked\', series_count INT NOT NULL DEFAULT 1,' +
        'status VARCHAR(16) NOT NULL DEFAULT \'waiting\', current_game INT NOT NULL DEFAULT 1, order_json JSON NULL,' +
        'created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, INDEX idx_status_updated (status, updated_at)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      await vdb.query('CREATE TABLE `' + tmpDb + '`.`series` (' +
        'id BIGINT PRIMARY KEY AUTO_INCREMENT, room_id BIGINT NOT NULL, game_no INT NOT NULL, mode VARCHAR(24) NOT NULL,' +
        'order_json JSON NULL, status VARCHAR(16) NOT NULL DEFAULT \'drafting\', winner VARCHAR(8) NULL,' +
        'started_at DATETIME(3) NOT NULL, finished_at DATETIME(3) NULL, UNIQUE KEY uk_room_game (room_id, game_no),' +
        'INDEX idx_room (room_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      await vdb.query('CREATE TABLE `' + tmpDb + '`.`actions` (' +
        'id BIGINT PRIMARY KEY AUTO_INCREMENT, series_id BIGINT NOT NULL, seq INT NOT NULL, step_index INT NOT NULL,' +
        'side VARCHAR(8) NOT NULL, `action` VARCHAR(8) NOT NULL, hero_id INT NOT NULL, hero_name VARCHAR(40) NOT NULL,' +
        'player_key VARCHAR(64) NULL, nickname VARCHAR(40) NULL, acted_at DATETIME(3) NOT NULL, gap_ms INT NOT NULL DEFAULT 0,' +
        'UNIQUE KEY uk_series_seq (series_id, seq), INDEX idx_series (series_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      const tnow = new Date();
      const lr = await vdb.query('INSERT INTO `' + tmpDb + '`.`rooms` (code, name, mode, series_count, status, current_game, order_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [legacyCode, 'v2 老房（有动作）', 'ranked', 1, 'drafting', 1, null, tnow, tnow]);
      const lr2 = await vdb.query('INSERT INTO `' + tmpDb + '`.`rooms` (code, name, mode, series_count, status, current_game, order_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [quietCode, 'v2 老房（没动作）', 'ranked', 1, 'waiting', 1, null, tnow, tnow]);
      await vdb.query('INSERT INTO `' + tmpDb + '`.`series` (room_id, game_no, mode, order_json, status, winner, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [lr.insertId, 1, 'ranked', null, 'drafting', null, tnow]);
      const lsRows = await vdb.query('SELECT id FROM `' + tmpDb + '`.`series` WHERE room_id = ? LIMIT 1', [lr.insertId]);
      await vdb.query('INSERT INTO `' + tmpDb + '`.`actions` (series_id, seq, step_index, side, `action`, hero_id, hero_name, player_key, nickname, acted_at, gap_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [lsRows[0].id, 1, 0, 'blue', 'ban', 105, '廉颇', 'legacy-key', '老房主', tnow, 0]);

      /* 子进程里连这个临时库，init() 连跑两次（= 老库升级 + 重启幂等） */
      fs.writeFileSync(tmpScript, [
        "'use strict';",
        'const db = require(' + JSON.stringify(path.join(ROOT, 'server', 'db.js')) + ');',
        '(async () => {',
        '  const runs = [];',
        '  await db.init();',
        '  runs.push(db.migration());',
        '  await db.init();',
        '  runs.push(db.migration());',
        "  const cols = await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?', [process.env.WZBP_DB_NAME, 'rooms']);",
        "  const rooms = await db.query('SELECT code, launched FROM rooms ORDER BY id ASC');",
        "  console.log('MIGRESULT ' + JSON.stringify({ runs, cols: cols.map(function (c) { return String(c.column_name); }), rooms }));",
        '  await db.close();',
        "})().catch(function (e) { console.error('MIGFAIL ' + (e && e.stack ? e.stack : e)); process.exit(1); });"
      ].join('\n'), 'utf8');

      const outFd = fs.openSync(tmpOut, 'w');
      const migEnv = Object.assign({}, process.env, { WZBP_DB_NAME: tmpDb });
      const migChild = spawn(process.execPath, [tmpScript], {
        cwd: ROOT, env: migEnv, stdio: ['ignore', outFd, outFd], windowsHide: true
      });
      const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => { try { migChild.kill(); } catch (e) { /* 忽略 */ } resolve('timeout'); }, 60000);
        migChild.on('exit', (code) => { clearTimeout(timer); resolve(code); });
        migChild.on('error', () => { clearTimeout(timer); resolve('spawn-error'); });
      });
      try { fs.closeSync(outFd); } catch (e) { /* 忽略 */ }
      childOut = fs.readFileSync(tmpOut, 'utf8');

      checkEq('隔离临时库：子进程连跑两次 init 都成功（退出码 0）', exitCode, 0);
      const hit = childOut.match(/MIGRESULT (\{[\s\S]*\})/);
      check('隔离临时库：拿到迁移结果', !!hit, childOut.trim().slice(-300));
      if (hit) {
        const mig = JSON.parse(hit[1]);
        checkEq('老库第一次 init：新增 3 列（launched / turn_seconds / paused）',
          mig.runs[0].added.join(','), 'rooms.launched,rooms.turn_seconds,rooms.paused');
        checkEq('老库第一次 init：回填 1 个「已有动作」的房间',
          mig.runs[0].backfilled, 1);
        checkEq('第二次 init：不再重复 ALTER（added 为空 → 幂等）', mig.runs[1].added.length, 0);
        checkEq('第二次 init：没有需要再回填的房间（backfilled=0）', mig.runs[1].backfilled, 0);
        for (const c of ['launched', 'turn_seconds', 'paused']) {
          check('升级后临时库 rooms 有列 ' + c, mig.cols.map((x) => x.toLowerCase()).indexOf(c) >= 0, mig.cols.join(','));
        }
        const leg = mig.rooms.find((r) => r.code === legacyCode);
        const quiet = mig.rooms.find((r) => r.code === quietCode);
        checkEq('已有动作的老房升级后 launched=1（历史房间还能继续打）', leg && Number(leg.launched), 1);
        checkEq('没有动作的老房升级后 launched=0（不会误放行）', quiet && Number(quiet.launched), 0);
      }
      console.log('    ↳ 老库升级原始输出（子进程 stdout）：' + (childOut.trim().split('\n').filter((l) => l.startsWith('MIG')).join(' | ').slice(0, 500) || '（空）'));
    } catch (e) {
      check('隔离临时库迁移验证执行完成', false, e && e.message);
    } finally {
      try { await vdb.query('DROP DATABASE IF EXISTS `' + tmpDb + '`'); } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(tmpScript); } catch (e) { /* 忽略 */ }
      try { fs.unlinkSync(tmpOut); } catch (e) { /* 忽略 */ }
    }

    await vdb.close();
    console.log('    （真库证据：以上断言直接读 ' + DBNAME + ' 的 information_schema / room_admins / admin_tokens）');
  }

  sse.close();
  return { code: CODE, peakCode, rndCode };
}

/* ============================================================
   启动 / 跳过判定
   ============================================================ */

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

function skip(reason) {
  console.log('');
  console.log('跳过：未配置数据库');
  console.log('  原因：' + reason);
  console.log('  说明：按契约 §10 的要求，本机没有可用 MySQL 时本脚本优雅跳过（退出码 0），不误报失败。');
  console.log('  想要完整自检：');
  console.log('    1) 在有 MySQL 的机器上执行 npm install && npm start，然后重跑本脚本；');
  console.log('    2) 或对已启动的服务执行：node scripts/verify-server.mjs --base=http://127.0.0.1:8787；');
  console.log('    3) 或临时用内存驱动跑接口逻辑（**不是真实 MySQL**）：node scripts/verify-server.mjs --memory');
  console.log('');
  if (OPT.requireDb) {
    console.log('但是指定了 --require-db：视同自检失败，退出码 1。');
    return 1;
  }
  return 0;
}

async function probeMysql() {
  try {
    require.resolve('mysql2/promise');
  } catch (e) {
    return { ok: false, reason: '本机未安装 mysql2 依赖（项目根目录执行 npm install 后再试）' };
  }
  const host = process.env.WZBP_DB_HOST || '127.0.0.1';
  const port = Number(process.env.WZBP_DB_PORT || 3306);
  const reachable = await tcpProbe(host, port, 3000);
  if (!reachable) return { ok: false, reason: '连不上 MySQL ' + host + ':' + port + '（3 秒超时）' };
  return { ok: true };
}

let BASE = OPT.base || ('http://127.0.0.1:' + OPT.port);
let child = null;
let logPath = null;
let logFd = null;

function readLog() {
  try { return fs.readFileSync(logPath, 'utf8'); } catch (e) { return ''; }
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return { ok: false, reason: '服务进程已退出（exitCode=' + child.exitCode + '）' };
    try {
      const r = await request('GET', '/api/health', { base: BASE });
      if (r.status === 200 && r.json && r.json.ok) return { ok: true, health: r.json };
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  return { ok: false, reason: '等待 /api/health 超时（' + timeoutMs + 'ms）' };
}

async function main() {
  console.log('='.repeat(64));
  console.log('wzbp 后端自检 · scripts/verify-server.mjs（契约 §10）');
  if (OPT.base) {
    console.log('模式：对接已启动的服务 ' + OPT.base);
  } else if (OPT.memory) {
    console.log('模式：**内存驱动（非真实 MySQL）**');
    console.log('      只验证 HTTP/校验/SSE 逻辑；数据库语义由 server/memory-driver.js 模拟，');
    console.log('      不能替代真实 MySQL 验证。真实库验证请看默认模式。');
  } else {
    const probe = await probeMysql();
    if (!probe.ok) {
      console.log('='.repeat(64));
      const code = skip(probe.reason);
      process.exitCode = code;
      return;
    }
    console.log('模式：真实 MySQL（' + (process.env.WZBP_DB_HOST || '127.0.0.1') + ':' +
      (process.env.WZBP_DB_PORT || 3306) + '/' + (process.env.WZBP_DB_NAME || 'wzbp') + '）');
  }
  console.log('='.repeat(64));

  if (!OPT.base) {
    logPath = path.join(os.tmpdir(), 'wzbp-verify-' + Date.now() + '.log');
    logFd = fs.openSync(logPath, 'w');
    const env = Object.assign({}, process.env, {
      WZBP_PORT: String(OPT.port),
      WZBP_DB_DRIVER: OPT.memory ? 'memory' : 'mysql'
    });
    /* 本进程自己也要 require server/db.js（迁移证据组），驱动保持一致 */
    if (OPT.memory) process.env.WZBP_DB_DRIVER = 'memory';
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT, env,
      /* 用文件而不是管道收日志：避免极少数受限环境下管道 stdio 被拦 */
      stdio: ['ignore', logFd, logFd],
      windowsHide: true
    });
    const up = await waitHealthy(20000);
    if (!up.ok) {
      console.error('\n启动失败：' + up.reason);
      console.error('---- 服务日志 ----');
      console.error(readLog().trim() || '（没有日志输出）');
      console.error('------------------');
      if (logFd) { try { fs.closeSync(logFd); } catch (e) { /* 忽略 */ } }
      if (child) child.kill();
      process.exitCode = 1;
      return;
    }
    console.log('服务已就绪：' + BASE + '（driver=' + up.health.driver + '）');
  }

  let result = null;
  try {
    result = await runSuite();
  } catch (e) {
    FAILURES.push('未捕获异常：' + (e && e.stack ? e.stack : e));
    console.log('\n✘ 自检过程中抛出异常：' + (e && e.stack ? e.stack : e));
  }

  console.log('\n' + '='.repeat(64));
  console.log('通过 ' + PASS + ' 项，失败 ' + FAILURES.length + ' 项');
  if (FAILURES.length) {
    console.log('\n失败明细：');
    FAILURES.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    if (logPath) {
      console.log('\n---- 服务日志（尾部）----');
      const log = readLog().trim().split('\n').slice(-25).join('\n');
      console.log(log || '（没有日志输出）');
      console.log('------------------------');
    }
  } else {
    console.log('全部通过：' + (OPT.memory ? '（内存驱动，非真实 MySQL）' : ''));
  }
  console.log('='.repeat(64));

  if (child && !OPT.keep) child.kill();
  if (logFd) { try { fs.closeSync(logFd); } catch (e) { /* 忽略 */ } }
  if (!FAILURES.length && logPath) {
    try { fs.unlinkSync(logPath); } catch (e) { /* 忽略 */ }
  } else if (logPath) {
    console.log('服务日志保留在：' + logPath);
  }
  process.exitCode = FAILURES.length ? 1 : 0;
}

main().catch((e) => {
  console.error('自检脚本自身出错：', e && e.stack ? e.stack : e);
  if (child) child.kill();
  process.exitCode = 1;
});
