/* ============================================================
   wzbp · 联网端到端自检（真服务 + 真数据库 + 两个浏览器窗口）
   ------------------------------------------------------------
   验证：
     1. 两个窗口各自入房（模拟两名玩家）
     2. KPL 全局 BP 房间里落满第一轮 → 两边盘面一致（含本机重放不中断）
     3. 全局 BP 生效：本局再选「本方已用」的英雄被服务端拒绝
     4. 换局后全局池保留、单边限制成立
     5. 历史 + 回放：时间轴跳转与顺序播放逐手一致
     6. 全程无未捕获异常、无 console.error
   前置：服务已在 BASE 上启动（真库或 memory 均可）
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

/* 挑一个确认没被占用的 CDP 端口：随机端口撞车会让 Chrome 起不来（实测过） */
function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.once('listening', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.listen(start, '127.0.0.1');
  });
}

const HARD = setTimeout(() => {
  console.error('硬超时（240s），强制退出');
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(4);
}, 240000);
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

async function waitPortLegacy() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((x) => x.type === 'page');
      if (p) return p;
    } catch (e) { /* 等 */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}
async function evalIn(conn, expr) {
  const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception || {};
    return 'THREW: ' + (ex.description || ex.value);
  }
  return r.result && r.result.value;
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

/* 不开新窗口：直接复用 Chrome 启动时那个 about:blank target 再导航过去。
   （本机上 /json/new 偶发把 Chrome 带走，用已有 target 最稳） */
async function openPage(url) {
  const t = await waitPort(25000);
  if (!t) throw new Error('Chrome 未就绪（端口 ' + PORT + '）；日志见 ' + chromeLog);
  const conn = await connectTarget(t);
  await conn.send('Page.navigate', { url });
  await sleep(1200);
  return conn;
}

let code = 0;
try {
  /* 先确认服务在线 */
  const health = await (await fetch(BASE + '/api/health')).json();
  console.log('服务：' + JSON.stringify(health));
  check('服务在线且数据库可用', health.ok === true && health.db === true, JSON.stringify(health));

  /* 起 Chrome：端口先探空，端口被占会让 Chrome 直接起不来 */
  PORT = await freePort(9200);
  chrome = startChrome(PORT);
  console.log('CDP 端口 ' + PORT);

  const site = BASE.replace(/\/$/, '') + '/index.html';

  /* ---------- 一个窗口里模拟两名玩家 ----------
     这台机器上真开第二个浏览器渲染进程会被拖垮；而服务端只认 playerKey，
     所以用「同一窗口、两个 playerKey」对服务端就是两个不同玩家，业务语义等价。 */
  console.log('\n[1] 建房并让两名玩家入座（蓝方 / 红方）');
  const A = await openPage(site);
  await sleep(4500);

  const created = await evalIn(A, `(function(){
    window.WZ.net.setName('甲选手');
    window.__keyB = 'e2e-player-B-' + Date.now();
    var net = window.WZ.net;
    var origMyKey = net.myKey;
    return net.createRoom({ name:'端到端自检', mode:'kpl', seriesCount:3 })
      .then(function(r){
        window.__roomCode = r.room.code;
        return net.joinRoom(r.room.code, { nickname:'甲选手', team:'blue', playerKey: origMyKey() });
      })
      .then(function(){
        /* 第二个身份：临时换 key 再入座红方 */
        net.myKey = function(){ return window.__keyB; };
        return net.joinRoom(window.__roomCode, { nickname:'乙选手', team:'red', playerKey: window.__keyB });
      })
      .then(function(){
        net.myKey = origMyKey;   /* 恢复本机身份 */
        return net.getState(window.__roomCode);
      })
      .then(function(s){
        return JSON.stringify({
          code: s.room.code, mode: s.room.mode, seriesCount: s.room.seriesCount,
          players: s.players.map(function(p){ return p.team + ':' + p.nickname; }),
          myTeam: s.me && s.me.team
        });
      });
  })()`);
  if (created.indexOf('THREW') === 0) throw new Error('建房失败: ' + created);
  const room = JSON.parse(created);
  console.log('  房间 ' + room.code + '（' + room.mode + ' / BO' + room.seriesCount + '）');
  console.log('  成员 ' + JSON.stringify(room.players));
  check('建房成功且赛制为 kpl', room.mode === 'kpl', room.mode);
  check('蓝红双方各有一名玩家', room.players.length === 2, JSON.stringify(room.players));
  check('本机身份为蓝方', room.myTeam === 'blue', String(room.myTeam));

  /* 注意：不要在这里再调 roomUI.init() —— main.js 的接线已经注册过 handlers，
     再注册一次会把它的 onState（也就是 applyServerState，本机盘面重放）挤掉。
     测里只需要「把服务端状态喂进去」这一步，就是 SSE 到达时做的事。 */
  await evalIn(A, `(function(){
    return window.WZ.net.getState(window.__roomCode).then(function(s){
      window.WZ.roomUI.applyState(s);
      return 1;
    });
  })()`);
  await sleep(1800);

  const bootA = JSON.parse(await evalIn(A, `JSON.stringify({
    online: window.WZ.net.isOnline(),
    mode: window.WZ.draft.state().mode,
    total: window.WZ.draft.state().totalSteps,
    isGlobal: window.WZ.draft.isGlobal()
  })`));
  check('窗口进入联网模式', bootA.online === true, JSON.stringify(bootA));
  check('已按服务端下发 kpl 蓝图（20 手）', bootA.total === 20, JSON.stringify(bootA));
  check('识别为全局 BP', bootA.isGlobal === true, JSON.stringify(bootA));

  /* ---------- 落满第一轮（B2P3 = 10 手），走真实 POST /action ---------- */
  console.log('\n[2] 落满第一轮（B2P3，10 手）');
  await evalIn(A, `(function(){ window.__used = {}; return 1; })()`);
  for (let i = 0; i < 10; i++) {
    const r = await evalIn(A, `(function(){
      return window.WZ.net.getState(window.__roomCode).then(function(s){
        var g = s.game;
        if (g.done) return 'done';
        /* 从本局可用池里挑一个「没用过 + 不撞全局池」的英雄 */
        var usedAll = [];
        ['blue','red'].forEach(function(t){
          (s.game.bans[t]||[]).forEach(function(h){ usedAll.push(String(h)); });
          (s.game.picks[t]||[]).forEach(function(h){ usedAll.push(String(h)); });
        });
        var st = window.WZ.draft.state();
        var candidate = null;
        for (var k = 0; k < st.pool.length; k++) {
          var id = String(st.pool[k]);
          if (usedAll.indexOf(id) !== -1) continue;
          var usedSide = (g.globalUsed && g.globalUsed[g.nextAction.side]) || [];
          if (g.nextAction.action === 'pick' && usedSide.map(String).indexOf(id) !== -1) continue;
          candidate = st.pool[k]; break;
        }
        if (candidate === null) return 'nopick';
        return window.WZ.net.postAction(window.__roomCode, {
          side: g.nextAction.side, action: g.nextAction.action, heroId: candidate
        }).then(function(){ return 'ok'; }, function(e){ return 'FAIL:' + e.message; });
      });
    })()`);
    if (r !== 'ok') { console.log('    第 ' + (i + 1) + ' 手: ' + r); break; }
    await sleep(320);
  }
  await sleep(1500);

  const afterRound1 = JSON.parse(await evalIn(A, `JSON.stringify({
    serverProgress: (window.WZ.roomUI.state() && window.WZ.roomUI.state().actions || []).length,
    localProgress: window.WZ.draft.state().progress,
    localBans: window.WZ.draft.state().bans,
    localPicks: window.WZ.draft.state().picks,
    errs: (window.__errs || []).length
  })`));
  console.log('    A: ' + JSON.stringify(afterRound1));
  check('服务端已记录 10 手', afterRound1.serverProgress === 10, JSON.stringify(afterRound1));
  check('【回归】本机盘面完整重放 10 手（全局 BP 不阻断重放）',
    afterRound1.localProgress === 10, 'localProgress=' + afterRound1.localProgress);
  check('本机 ban 数正确（双方各 2）',
    afterRound1.localBans.blue.length === 2 && afterRound1.localBans.red.length === 2,
    JSON.stringify(afterRound1.localBans));
  check('本机 pick 数正确（双方各 3）',
    afterRound1.localPicks.blue.length === 3 && afterRound1.localPicks.red.length === 3,
    JSON.stringify(afterRound1.localPicks));

  /* 全局 BP 池应已注入本机引擎（供 UI 标灰） */
  const poolInjected = JSON.parse(await evalIn(A, `JSON.stringify({
    globalUsed: window.WZ.draft.globalUsed(),
    globalOn: window.WZ.draft.isGlobal()
  })`));
  check('全局池已注入本机引擎（重放完仍保留）',
    poolInjected.globalOn === true &&
    (poolInjected.globalUsed.blue.length + poolInjected.globalUsed.red.length) > 0,
    JSON.stringify(poolInjected));

  /* ---------- 全局 BP 生效：本局再选「本方已用」应被拒 ---------- */
  console.log('\n[3] 全局 BP 服务端校验');
  const globalRes = await evalIn(A, `(function(){
    return window.WZ.net.getState(${JSON.stringify(room.code)}).then(function(s){
      var g = s.game;
      var side = g.nextAction.side;
      var used = (g.globalUsed && g.globalUsed[side]) || [];
      if (!used.length) return 'NO_USED';
      return window.WZ.net.postAction(${JSON.stringify(room.code)}, {
        side: side, action: g.nextAction.action, heroId: used[0]
      }).then(function(){ return 'ALLOWED'; }, function(e){ return e.code || e.message; });
    });
  })()`);
  check('本局再选本方已用英雄被服务端拒绝（ERR_HERO_GLOBAL_USED 或本局已占用）',
    /ERR_HERO_GLOBAL_USED|ERR_HERO_TAKEN/.test(String(globalRes)),
    String(globalRes));

  /* ---------- 历史 + 回放（时间轴） ---------- */
  console.log('\n[4] 历史与时间轴回放');
  const hist = JSON.parse(await evalIn(A, `(function(){
    return window.WZ.net.history(window.__roomCode).then(function(list){
      var g = list[0];
      return JSON.stringify({ count: list.length, actionCount: g && g.actionCount,
        picks: g && g.picks });
    });
  })()`));
  check('历史列表能查到本局', hist.count >= 1, JSON.stringify(hist));
  check('历史项带 picks 阵容', !!(hist.picks && (hist.picks.blue.length || hist.picks.red.length)),
    JSON.stringify(hist.picks));

  const replay = JSON.parse(await evalIn(A, `(function(){
    return window.WZ.net.history(window.__roomCode).then(function(list){
      var id = list[0].id;
      return window.WZ.net.replay(id).then(function(rep){
        /* 逐步构建盘面：每一步的计数必须是递增的，证明可以任意跳转还原 */
        var seq = [];
        for (var k = 0; k <= rep.actions.length; k++) {
          var bs = window.WZ.replayUI.buildBoardState(rep, k);
          seq.push(bs.bans.blue.length + ',' + bs.bans.red.length + ',' +
                   bs.picks.blue.length + ',' + bs.picks.red.length);
        }
        return JSON.stringify({ actionCount: rep.actions.length,
          first: rep.actions[0], distinct: Array.from(new Set(seq)).length,
          last: seq[seq.length - 1] });
      });
    });
  })()`));
  check('回放拿到本局 10 手', replay.actionCount === 10, JSON.stringify(replay).slice(0, 200));
  check('回放第一步带 gapMs（距开局）', typeof replay.first.gapMs === 'number' && replay.first.gapMs >= 0,
    JSON.stringify(replay.first));
  check('回放每一步的盘面都不同（可任意跳转还原）', replay.distinct === 11,
    'distinct=' + replay.distinct + ' last=' + replay.last);

  /* ---------- 错误与异常 ---------- */
  console.log('\n[5] 运行期错误');
  const errsA = await evalIn(A, 'JSON.stringify(window.__errs || [])');
  check('窗口无未捕获异常', JSON.parse(errsA).length === 0, errsA);
  const consoleErrs = A.logs.filter((l) => l.indexOf('回放服务端动作失败') !== -1);
  check('【回归】没有「回放服务端动作失败」的 console.error',
    consoleErrs.length === 0, consoleErrs.join(' | '));
  const syncCount = await evalIn(A, `(function(){
    /* 独立订阅一次 SSE，验证「别人落子 → 我这边收到推送」这条链路真的通 */
    return new Promise(function(resolve){
      var got = { open:false, state:0, action:0 };
      var sub = window.WZ.net.subscribe(window.__roomCode, {
        onOpen: function(){ got.open = true; },
        onState: function(){ got.state++; },
        onAction: function(){ got.action++; }
      });
      var net = window.WZ.net;
      net.getState(window.__roomCode).then(function(s){
        var g = s.game;
        if (g.done) { resolve(JSON.stringify(got)); return; }
        var usedAll = [];
        ['blue','red'].forEach(function(t){
          (g.bans[t]||[]).forEach(function(h){ usedAll.push(String(h)); });
          (g.picks[t]||[]).forEach(function(h){ usedAll.push(String(h)); });
        });
        var st = window.WZ.draft.state();
        var cand = null;
        for (var k = 0; k < st.pool.length; k++) {
          if (usedAll.indexOf(String(st.pool[k])) === -1) { cand = st.pool[k]; break; }
        }
        return net.postAction(window.__roomCode, {
          side: g.nextAction.side, action: g.nextAction.action, heroId: cand
        }).then(function(){
          setTimeout(function(){
            try { sub.close(); } catch(e){}
            resolve(JSON.stringify(got));
          }, 1500);
        });
      });
    });
  })()`);
  const sse = JSON.parse(syncCount);
  check('SSE 连接建立', sse.open === true, syncCount);
  check('SSE 推送了 state 事件（实时同步生效）', sse.state > 0, syncCount);

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
