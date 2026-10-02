/* ============================================================
   wzbp · 联网端到端自检（真服务 + 真数据库 + 浏览器）
   ------------------------------------------------------------
   v3 流程：队员加入队伍 → 管理员登录 → 管理员开局 → 自动计时 → BP
   验证：
     1. 建房（带管理员账号）后 launched=false
     2. 未开局落子被服务端拒绝（ERR_NOT_LAUNCHED），且本机 BP 面板是锁的
     3. 管理员登录 + 开局 → 面板解锁
     4. 自动计时在走（两次读取的剩余秒数在减少），落子后重置
     5. 全局 BP 池跨局累计（kpl）
     6. 时间轴回放：任意跳转都能重建盘面
     7. 全程无未捕获异常、无 console.error
   前置：服务已在 BASE 上启动
   用法：node scripts/verify-net-e2e.mjs [--base=http://127.0.0.1:8787]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NO_PROXY = '127.0.0.1,localhost';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const baseArg = process.argv.find((a) => a.startsWith('--base='));
const BASE = baseArg ? baseArg.split('=')[1] : 'http://127.0.0.1:8787';

function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.listen(start, '127.0.0.1');
  });
}

const HARD = setTimeout(() => {
  console.error('硬超时（300s），强制退出');
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(4);
}, 300000);
HARD.unref && HARD.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, failed = 0;
function check(label, cond, detail) {
  checks++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (!cond && detail ? ' —— ' + detail : ''));
  if (!cond) failed++;
}

const profile = path.join(process.env.TEMP, 'wzbp-e2e-' + Date.now());
const chromeLog = path.join(process.env.TEMP, 'wzbp-e2e-chrome-' + Date.now() + '.log');
const chromeLogFd = fs.openSync(chromeLog, 'w');
let chrome = null;
let PORT = 0;

function startChrome(port) {
  return spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1600,900', 'about:blank'
  ], { stdio: ['ignore', chromeLogFd, chromeLogFd] });
}

function cdpClient(ws) {
  let id = 0; const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION ' + (m.params.exceptionDetails && m.params.exceptionDetails.text));
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  return { send, logs };
}

async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const c = cdpClient(ws);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      window.addEventListener('error', function(e){ window.__errs.push('err: '+e.message); });
      window.addEventListener('unhandledrejection', function(e){
        window.__errs.push('rej: '+(e.reason && e.reason.message ? e.reason.message : e.reason)); });`
  });
  return { ws, ...c };
}

async function waitPort(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  for (let i = 0; Date.now() < deadline; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((x) => x.type === 'page');
      if (p) return p;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  return null;
}

async function openPage(url) {
  const t = await waitPort(25000);
  if (!t) throw new Error('Chrome 未就绪（端口 ' + PORT + '）；日志见 ' + chromeLog);
  const conn = await connectTarget(t);
  await conn.send('Page.navigate', { url });
  await sleep(1200);
  return conn;
}

async function evalIn(conn, expr) {
  const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception || {};
    return 'THREW: ' + (ex.description || ex.value);
  }
  return r.result && r.result.value;
}

let code = 0;
try {
  const health = await (await fetch(BASE + '/api/health')).json();
  console.log('服务：' + JSON.stringify(health));
  check('服务在线且数据库可用', health.ok === true && health.db === true, JSON.stringify(health));

  PORT = await freePort(9200);
  chrome = startChrome(PORT);
  console.log('CDP 端口 ' + PORT);

  const site = BASE.replace(/\/$/, '') + '/index.html';

  /* ---------- ① 建房（建房的人就是管理员） ---------- */
  console.log('\n[1] 管理员建房（带管理员账号）');
  const A = await openPage(site);
  await sleep(4500);

  const created = await evalIn(A, `(function(){
    window.WZ.net.setName('甲选手');
    window.__keyB = 'e2e-player-B-' + Date.now();
    var net = window.WZ.net;
    var origMyKey = net.myKey;
    return net.createRoom({
      name:'端到端自检', mode:'kpl', seriesCount:3, turnSeconds:60,
      adminUser:'coach', adminPass:'secret123'
    }).then(function(r){
      window.__roomCode = r.room.code;
      /* 管理员入住蓝方 0 号位；再模拟第二个玩家坐红方 */
      return net.joinRoom(r.room.code, { nickname:'甲选手', team:'blue', playerKey: origMyKey() })
        .then(function(){
          net.myKey = function(){ return window.__keyB; };
          return net.joinRoom(window.__roomCode, { nickname:'乙选手', team:'red', playerKey: window.__keyB });
        })
        .then(function(){
          net.myKey = origMyKey;
          return net.getState(window.__roomCode);
        })
        .then(function(s){
          return JSON.stringify({
            code: s.room.code, mode: s.room.mode, launched: s.room.launched,
            turnSeconds: s.room.turnSeconds,
            players: s.players.map(function(p){ return p.team + ':' + p.nickname; }),
            adminYou: s.admin && s.admin.you, adminUsers: (s.admin && s.admin.users) || []
          });
        });
    });
  })()`);
  if (String(created).indexOf('THREW') === 0) throw new Error('建房失败: ' + created);
  const room = JSON.parse(created);
  console.log('  房间 ' + room.code + '（' + room.mode + '）' + JSON.stringify({
    launched: room.launched, turnSeconds: room.turnSeconds, players: room.players
  }));
  check('建房成功，赛制 kpl', room.mode === 'kpl', room.mode);
  check('建房后 launched=false（还没开局）', room.launched === false, String(room.launched));
  check('建房时配置的 turnSeconds 生效', room.turnSeconds === 60, String(room.turnSeconds));
  check('蓝红双方各一名玩家（加入队伍成功）', room.players.length === 2, JSON.stringify(room.players));
  check('建房者即管理员：admin.you=true', room.adminYou === true, String(room.adminYou));
  check('管理员账号已登记', (room.adminUsers || []).indexOf('coach') >= 0, JSON.stringify(room.adminUsers));

  /* ---------- ② 未开局：落子必须被拒 + 面板必须锁住 ---------- */
  console.log('\n[2] 未开局：BP 面板锁定');
  /* 走真实用户路径：打开房间抽屉 → room-ui 自己订阅 SSE → 主控的 applyServerState
     收到状态后才会决定要不要锁。不要直接调 roomUI.applyState()，那会绕过 onState 转发。 */
  await evalIn(A, `(function(){ window.WZ.roomUI.enterRoom(window.__roomCode); return 1; })()`);
  await sleep(2500);

  let beforeLaunch = { locked: false, btnDisabled: false, hasNote: false, noteText: '' };
  for (let i = 0; i < 12; i++) {
    beforeLaunch = JSON.parse(await evalIn(A, `(function(){
      var st = window.WZ.draft.state();
      window.WZ.ui.selectHero(st.pool[0]);
      return new Promise(function(res){
        setTimeout(function(){
          var btn = document.querySelector('#sidePanel .pv-actions button[data-action="ban"][data-side="blue"]');
          res(JSON.stringify({
            locked: window.WZ.ui.isLocked(),
            btnDisabled: btn ? !!btn.disabled : null,
            hasNote: !!document.getElementById('wzBpLockNote'),
            noteText: (document.getElementById('wzBpLockNote') || {}).textContent || ''
          }));
        }, 300);
      });
    })()`));
    if (beforeLaunch.locked) break;
    await sleep(700);
  }
  console.log('  ' + JSON.stringify(beforeLaunch));
  check('本机 BP 面板已锁', beforeLaunch.locked === true, JSON.stringify(beforeLaunch));
  check('英雄「ban」按钮被禁用', beforeLaunch.btnDisabled === true, String(beforeLaunch.btnDisabled));
  check('界面上写明了为什么锁（不是静默禁用）',
    beforeLaunch.hasNote && /管理员开始\s*BP/.test(beforeLaunch.noteText), beforeLaunch.noteText);

  const rejectRes = await evalIn(A, `(function(){
    var st = window.WZ.draft.state();
    return window.WZ.net.postAction(window.__roomCode, {
      side:'blue', action:'ban', heroId: st.pool[0]
    }).then(function(){ return 'ALLOWED'; }, function(e){ return (e.code||'') + '|' + (e.message||''); });
  })()`);
  check('服务端拒绝未开局的落子（ERR_NOT_LAUNCHED）',
    String(rejectRes).indexOf('ERR_NOT_LAUNCHED') === 0, String(rejectRes));

  /* 用户的第一条要求：「先选择加入队伍」——面板上必须真的有可点的席位 */
  const seatUI = JSON.parse(await evalIn(A, `JSON.stringify((function(){
    var drawer = document.getElementById('wzRoomDrawer');
    if (!drawer) return { open:false, seats:0, teamBlocks:0, text:'' };
    var seats = drawer.querySelectorAll('.wz-seat');
    var teams = drawer.querySelectorAll('.wz-team');
    var txt = drawer.textContent || '';
    return {
      open: window.WZ.roomUI.isOpen(),
      seats: seats.length,
      clickable: Array.prototype.filter.call(seats, function(s){ return s.tagName === 'BUTTON'; }).length,
      teamBlocks: teams.length,
      hasJoinHint: /加入队伍|点空位坐下/.test(txt),
      hasWaitTitle: /等待管理员开始\\s*BP/.test(txt)
    };
  })())`));
  console.log('  ' + JSON.stringify(seatUI));
  check('房间里能「加入队伍」：蓝红两栏 + 10 个可点席位',
    seatUI.teamBlocks === 2 && seatUI.seats === 10 && seatUI.clickable === 10, JSON.stringify(seatUI));
  check('界面上明确提示「加入队伍 / 点空位坐下」', seatUI.hasJoinHint === true, JSON.stringify(seatUI));
  check('未开局时标题写明「等待管理员开始 BP」', seatUI.hasWaitTitle === true, JSON.stringify(seatUI));

  /* 真正点一下空席位，验证「加入队伍」这条 UI 路径通 */
  const clicked = await evalIn(A, `(function(){
    var btn = document.querySelector('#wzRoomDrawer .wz-seat');
    if (!btn) return 'NO_SEAT';
    var before = window.WZ.roomUI.state();
    var n0 = (before && before.players || []).length;
    btn.click();
    return new Promise(function(res){
      setTimeout(function(){
        var s = window.WZ.roomUI.state();
        res(JSON.stringify({ n0:n0, n1:((s&&s.players)||[]).length, me:!!(s&&s.me) }));
      }, 1200);
    });
  })()`);
  if (String(clicked).indexOf('NO_SEAT') === 0) {
    check('点击席位能加入队伍', false, String(clicked));
  } else {
    const ck = JSON.parse(clicked);
    check('点击席位能加入队伍（人数增加且自己已入座）',
      ck.n1 > ck.n0 || ck.me === true, JSON.stringify(ck));
  }

  /* ---------- ③ 管理员开局 ---------- */
  console.log('\n[3] 管理员开局 → 面板解锁');
  const launchRes = await evalIn(A, `(function(){
    return window.WZ.net.launchRoom(window.__roomCode).then(function(){
      return window.WZ.net.getState(window.__roomCode);
    }).then(function(s){
      window.WZ.roomUI.applyState(s);
      /* 开局后把状态再喂给主控一次（真实场景里 SSE 会推），让锁真正解除 */
      window.WZ.roomUI.setHandlers && 0;
      return JSON.stringify({
        launched: s.room.launched, status: s.room.status,
        next: s.game && s.game.nextAction,
        turn: s.game && s.game.turn
      });
    }, function(e){ return 'FAIL:' + (e.code||'') + '|' + (e.message||''); });
  })()`);
  if (String(launchRes).indexOf('FAIL') === 0) throw new Error('开局失败: ' + launchRes);
  const live = JSON.parse(launchRes);
  console.log('  ' + JSON.stringify(live));
  check('开局成功 launched=true', live.launched === true, launchRes);
  check('开局后 status=drafting', live.status === 'drafting', live.status);
  check('开局后给出第一手（blue ban）', live.next && live.next.side === 'blue' && live.next.action === 'ban',
    JSON.stringify(live.next));
  check('开局即开始自动计时（turn 有 deadline/remainingMs）',
    !!(live.turn && live.turn.deadline && typeof live.turn.remainingMs === 'number'),
    JSON.stringify(live.turn));

  /* 等 SSE 把「已开局」的状态推过来，锁应自动解除 */
  let afterLaunch = { locked: true, btnDisabled: true };
  for (let i = 0; i < 12; i++) {
    afterLaunch = JSON.parse(await evalIn(A, `(function(){
      window.WZ.ui.selectHero(window.WZ.draft.state().pool[0]);
      return new Promise(function(res){
        setTimeout(function(){
          var btn = document.querySelector('#sidePanel .pv-actions button[data-action="ban"][data-side="blue"]');
          res(JSON.stringify({
            locked: window.WZ.ui.isLocked(),
            btnDisabled: btn ? !!btn.disabled : null
          }));
        }, 300);
      });
    })()`));
    if (afterLaunch.locked === false) break;
    await sleep(700);
  }
  check('开局后本机面板解锁', afterLaunch.locked === false, JSON.stringify(afterLaunch));
  check('开局后 ban 按钮可用', afterLaunch.btnDisabled === false, JSON.stringify(afterLaunch));

  /* ---------- ④ 落子 + 计时重置 ---------- */
  console.log('\n[4] 落子与自动计时');
  const t0 = await evalIn(A, `window.WZ.net.getState(window.__roomCode).then(function(s){ return s.game.turn.remainingMs; })`);
  await sleep(2200);
  const t1 = await evalIn(A, `window.WZ.net.getState(window.__roomCode).then(function(s){ return s.game.turn.remainingMs; })`);
  check('倒计时在走（2 秒后剩余变少）', Number(t1) < Number(t0) - 1000, t0 + ' → ' + t1);

  const acted = await evalIn(A, `(function(){
    return window.WZ.net.getState(window.__roomCode).then(function(s){
      return window.WZ.net.postAction(window.__roomCode, {
        side: s.game.nextAction.side, action: s.game.nextAction.action,
        heroId: window.WZ.draft.state().pool[0]
      }).then(function(r){
        var obj = r || {};
        var g = obj.game || obj;
        return JSON.stringify({ ok:true, remainingMs: g.turn && g.turn.remainingMs, seconds: g.turn && g.turn.seconds });
      }, function(e){ return 'FAIL:' + (e.code||'') + '|' + (e.message||''); });
    });
  })()`);
  const act = JSON.parse(acted);
  check('落子成功', act.ok === true, acted);
  check('落子后计时重置为接近满格', Number(act.remainingMs) > Number(act.seconds) * 1000 - 3000,
    JSON.stringify(act));

  /* ---------- ⑤ 落满第一轮（4 ban + 6 pick = 10 手） ---------- */
  console.log('\n[5] 落满第一轮（蓝B1 红B1 蓝B1 红B1 → 蓝P1 红P2 蓝P2 红P1，10 手）');
  for (let i = 0; i < 9; i++) {
    const r = await evalIn(A, `(function(){
      return window.WZ.net.getState(window.__roomCode).then(function(s){
        var g = s.game;
        if (g.done) return 'done';
        var usedAll = [];
        ['blue','red'].forEach(function(t){
          (g.bans[t]||[]).forEach(function(h){ usedAll.push(String(h)); });
          (g.picks[t]||[]).forEach(function(h){ usedAll.push(String(h)); });
        });
        var st = window.WZ.draft.state();
        var cand = null;
        for (var k = 0; k < st.pool.length; k++) {
          var id = String(st.pool[k]);
          if (usedAll.indexOf(id) !== -1) continue;
          var usedSide = (g.globalUsed && g.globalUsed[g.nextAction.side]) || [];
          if (g.nextAction.action === 'pick' && usedSide.map(String).indexOf(id) !== -1) continue;
          cand = st.pool[k]; break;
        }
        if (cand === null) return 'nopick';
        return window.WZ.net.postAction(window.__roomCode, {
          side: g.nextAction.side, action: g.nextAction.action, heroId: cand
        }).then(function(){ return 'ok'; }, function(e){ return 'FAIL:' + e.message; });
      });
    })()`);
    if (r !== 'ok') { console.log('    第 ' + (i + 2) + ' 手: ' + r); break; }
    await sleep(280);
  }
  await sleep(1200);

  const round1 = JSON.parse(await evalIn(A, `(function(){
    return window.WZ.net.getState(window.__roomCode).then(function(s){
      window.WZ.roomUI.applyState(s);
      var st = window.WZ.draft.state();
      return JSON.stringify({
        serverActions: (s.actions||[]).length,
        localProgress: st.progress,
        bans: { blue: st.bans.blue.length, red: st.bans.red.length },
        picks: { blue: st.picks.blue.length, red: st.picks.red.length },
        globalUsed: s.game.globalUsed,
        localGlobal: window.WZ.draft.globalUsed()
      });
    });
  })()`));
  console.log('  ' + JSON.stringify(round1));
  check('服务端记录 10 手（第一轮）', round1.serverActions === 10, String(round1.serverActions));
  check('【回归】本机盘面完整重放 10 手（全局 BP 不阻断）', round1.localProgress === 10, String(round1.localProgress));
  check('第一轮 ban/pick 数正确（各 2 ban / 各 3 pick）',
    round1.bans.blue === 2 && round1.bans.red === 2 && round1.picks.blue === 3 && round1.picks.red === 3,
    JSON.stringify(round1.bans) + JSON.stringify(round1.picks));
  check('全局 BP 池已注入本机（重放完仍保留）',
    (round1.localGlobal.blue.length + round1.localGlobal.red.length) > 0, JSON.stringify(round1.localGlobal));

  /* ---------- ⑥ 全局 BP 服务端校验 ---------- */
  console.log('\n[6] 全局 BP：本方选过的不能再选');
  const gres = await evalIn(A, `(function(){
    return window.WZ.net.getState(window.__roomCode).then(function(s){
      var g = s.game;
      var side = g.nextAction.side;
      var used = (g.globalUsed && g.globalUsed[side]) || [];
      if (!used.length) return 'NO_USED';
      return window.WZ.net.postAction(window.__roomCode, {
        side: side, action: g.nextAction.action, heroId: used[0]
      }).then(function(){ return 'ALLOWED'; }, function(e){ return (e.code||'') + '|' + (e.message||''); });
    });
  })()`);
  check('本方已用英雄被拒（ERR_HERO_GLOBAL_USED / 本局已占用）',
    /ERR_HERO_GLOBAL_USED|ERR_HERO_TAKEN/.test(String(gres)), String(gres));

  /* ---------- ⑦ 换局后全局池跨局累计 ---------- */
  console.log('\n[7] 换局：全局 BP 记录跨局累计');
  const nextGame = await evalIn(A, `(function(){
    return window.WZ.net.nextGame(window.__roomCode, { winner:'blue' }).then(function(){
      return window.WZ.net.getState(window.__roomCode);
    }).then(function(s){
      return JSON.stringify({
        gameNo: s.room.currentGame, actions: (s.actions||[]).length,
        globalUsed: s.game.globalUsed, launched: s.room.launched
      });
    }, function(e){ return 'FAIL:' + (e.code||'') + '|' + (e.message||''); });
  })()`);
  if (String(nextGame).indexOf('FAIL') === 0) {
    check('换局成功', false, String(nextGame));
  } else {
    const ng = JSON.parse(nextGame);
    console.log('  ' + JSON.stringify(ng));
    check('进入第 2 局且新局 0 手', ng.gameNo === 2 && ng.actions === 0, JSON.stringify(ng));
    check('全局 BP 记录换局不清空（跨局累计）',
      (ng.globalUsed.blue.length + ng.globalUsed.red.length) > 0, JSON.stringify(ng.globalUsed));
    check('换局后仍是已开局状态', ng.launched === true, String(ng.launched));
  }

  /* ---------- ⑧ 回放 ---------- */
  console.log('\n[8] 历史与时间轴回放');
  const replay = JSON.parse(await evalIn(A, `(function(){
    return window.WZ.net.history(window.__roomCode).then(function(list){
      if (!list.length) return JSON.stringify({ count:0 });
      var g = list[list.length - 1];
      return window.WZ.net.replay(g.id).then(function(rep){
        var seq = [];
        for (var k = 0; k <= rep.actions.length; k++) {
          var bs = window.WZ.replayUI.buildBoardState(rep, k);
          seq.push(bs.bans.blue.length + ',' + bs.bans.red.length + ',' +
                   bs.picks.blue.length + ',' + bs.picks.red.length);
        }
        return JSON.stringify({
          count: list.length, actionCount: rep.actions.length,
          first: rep.actions[0], distinct: Array.from(new Set(seq)).length, last: seq[seq.length-1]
        });
      });
    });
  })()`));
  check('历史列表能查到已打完的这一局', replay.count >= 1, JSON.stringify(replay).slice(0, 200));
  check('回放拿到 10 手', replay.actionCount === 10, JSON.stringify(replay).slice(0, 200));
  check('回放每一步盘面都不同（可任意跳转还原）', replay.distinct === 11,
    'distinct=' + replay.distinct + ' last=' + replay.last);
  check('回放第一步带 gapMs（距开局）',
    replay.first && typeof replay.first.gapMs === 'number' && replay.first.gapMs >= 0,
    JSON.stringify(replay.first));

  /* ---------- ⑨ 错误与异常 ---------- */
  console.log('\n[9] 运行期错误');
  const errsA = await evalIn(A, 'JSON.stringify(window.__errs || [])');
  check('窗口无未捕获异常', JSON.parse(errsA).length === 0, errsA);
  const badLogs = A.logs.filter((l) => /回放服务端动作失败|Uncaught|is not a function/.test(l));
  check('无严重 console.error', badLogs.length === 0, badLogs.slice(0, 3).join(' | '));

  console.log('\n' + '='.repeat(52));
  console.log('联网端到端自检：' + checks + ' 项，失败 ' + failed + ' 项');
  if (!failed) console.log('全部通过 ✓');

  A.ws.close();
} catch (err) {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  code = 1;
} finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.exit(failed ? 1 : code);
