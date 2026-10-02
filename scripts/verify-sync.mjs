/* ============================================================
   wzbp · 双窗口同步自检
   ------------------------------------------------------------
   验证：控制窗操作 BP → 展示窗（index.html?wzrole=display）是否跟着变；
        撤销 / 重开是否同步；展示窗关掉后重开能否自动补齐当前局面；
        展示窗是否隐藏控制台、显示标记条。

   用法：node scripts/verify-sync.mjs
   注意：Windows 上 chrome.exe 直接把 file:// 当启动参数会失败，
        所以这里「先起 about:blank，再用 Page.navigate 过去」。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9100 + Math.floor(Math.random() * 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 兜底：任何一步卡住都不要无限挂着 */
const HARD_TIMEOUT = setTimeout(() => {
  console.error('硬超时（150s），强制退出');
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(4);
}, 150000);
HARD_TIMEOUT.unref && HARD_TIMEOUT.unref();

const fileUrl = (p, q) => 'file:///' + path.join(ROOT, p).split(path.sep).join('/') + (q || '');

const profile = path.join(process.env.TEMP, 'wzbp-dual-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

function cdpClient(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdpClient(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  return { ws, send };
}

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((x) => x.type === 'page');
      if (p) return p;
    } catch (e) { /* not up */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪（端口 ' + PORT + '）');
}

async function evalIn(conn, expr) {
  const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception || {};
    return 'THREW: ' + (ex.description || ex.value || JSON.stringify(r.exceptionDetails));
  }
  return r.result && r.result.value;
}

let code = 0;
try {
  /* 控制窗：复用启动 target 再导航 */
  const first = await waitPort();
  const console1 = await connectTarget(first);
  await console1.send('Page.navigate', { url: fileUrl('index.html') });
  await sleep(3000);
  console.log('· 控制窗 body=' + await evalIn(console1, 'document.body.className'));
  console.log('· 控制窗 heroes=' + await evalIn(console1, '(window.WZ.HEROES||[]).length'));

  /* 打 5 步 */
  console.log('· 控制窗执行 5 步 BP：' + await evalIn(console1, `(function(){
    var D = window.WZ.draft, n = 0;
    for (var i = 0; i < 5; i++) {
      var s = D.state(); if (s.done) break;
      if (D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]).ok) n++;
    }
    return JSON.stringify({applied:n, progress:D.state().progress, step:D.state().step});
  })()`));
  await sleep(900);

  /* 展示窗：新 target */
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(fileUrl('index.html', '?wzrole=display'))}`, { method: 'PUT' });
  const dt = await res.json();
  const display1 = await connectTarget(dt);
  await sleep(4000);

  console.log('\n—— 展示窗状态 ——');
  const d1raw = await evalIn(display1, `JSON.stringify({
    bodyClass: document.body.className,
    flagDisplay: getComputedStyle(document.getElementById('displayFlag')).display,
    appbarDisplay: getComputedStyle(document.querySelector('.appbar')).display,
    consoleDisplay: getComputedStyle(document.getElementById('console')).display,
    syncText: (document.getElementById('displaySync')||{}).textContent,
    progress: window.WZ.draft.state().progress,
    banFilled: document.querySelectorAll('.ban-slot.filled').length,
    pickFilled: document.querySelectorAll('.pick-slot.filled').length,
    stageName: document.getElementById('stageName').textContent,
    boardMode: document.getElementById('boardMode').textContent,
    boardPhase: document.getElementById('boardPhase').textContent
  })`);
  const d1 = JSON.parse(d1raw);
  console.log(JSON.stringify(d1, null, 1));

  let checks = 0, failed = 0;
  function check(label, cond, detail) {
    checks++;
    if (cond) { console.log('  ✓ ' + label); }
    else { failed++; code = 1; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
  }
  check('展示窗 body 带 role-display', d1.bodyClass.indexOf('role-display') !== -1, d1.bodyClass);
  check('展示窗显示顶部标记条', d1.flagDisplay !== 'none', d1.flagDisplay);
  check('展示窗隐藏顶栏', d1.appbarDisplay === 'none', d1.appbarDisplay);
  check('展示窗隐藏控制台', d1.consoleDisplay === 'none', d1.consoleDisplay);
  check('展示窗步数已同步（5 步）', d1.progress === 5, 'progress=' + d1.progress);
  check('展示窗 ban 位已同步（5 个）', d1.banFilled === 5, 'banFilled=' + d1.banFilled);
  check('展示窗赛制正确', d1.boardMode === '排位征召', d1.boardMode);

  /* 控制窗再走 3 步 */
  await evalIn(console1, `(function(){
    var D = window.WZ.draft;
    for (var i = 0; i < 3; i++) { var s = D.state(); if (s.done) break;
      D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]); }
    return 1;
  })()`);
  await sleep(1500);
  console.log('\n· 控制窗再走 3 步后，展示窗：' + await evalIn(display1, `JSON.stringify({
    progress: window.WZ.draft.state().progress,
    pickFilled: document.querySelectorAll('.pick-slot.filled').length,
    banFilled: document.querySelectorAll('.ban-slot.filled').length,
    stageName: document.getElementById('stageName').textContent,
    syncText: (document.getElementById('displaySync')||{}).textContent
  })`));

  /* 控制窗撤销 2 步 */
  await evalIn(console1, 'window.WZ.draft.undo(); window.WZ.draft.undo(); "ok"');
  await sleep(1500);
  console.log('· 控制窗撤销 2 步后，展示窗：' + await evalIn(display1, `JSON.stringify({
    progress: window.WZ.draft.state().progress,
    pickFilled: document.querySelectorAll('.pick-slot.filled').length,
    banFilled: document.querySelectorAll('.ban-slot.filled').length
  })`));

  /* 控制窗重开 —— 同时验证广播链路有没有真的被调用 */
  await evalIn(console1, `(function(){
    window.__trace = { changes: 0, posts: 0, sample: null };
    var origPost = window.WZ.sync.post;
    window.WZ.sync.post = function (m) {
      if (m && (m.t === 'update' || m.t === 'snapshot')) {
        window.__trace.posts++;
        window.__trace.sample = m.payload ? (m.payload.actions || []).length : -1;
      }
      return origPost.apply(this, arguments);
    };
    window.WZ.draft.on(function (s) {
      window.__trace.changes++;
      window.__trace.lastProgress = s ? s.progress : null;
    });
    window.WZ.draft.reset();
    return 'reset called';
  })()`);
  await sleep(1800);
  console.log('· 控制窗自身状态：' + await evalIn(console1, `JSON.stringify({
    progress: window.WZ.draft.state().progress,
    trace: window.__trace
  })`));
  console.log('· 控制窗重开后，展示窗：' + await evalIn(display1, `JSON.stringify({
    progress: window.WZ.draft.state().progress,
    pickFilled: document.querySelectorAll('.pick-slot.filled').length,
    banFilled: document.querySelectorAll('.ban-slot.filled').length,
    stageName: document.getElementById('stageName').textContent
  })`));

  /* ---------- 时序 2：展示窗「后开」时能否自动补齐当前局面 ----------
     真实场景：先开着控制窗做了一半，中途才开 OBS 的展示窗。
     新窗口上线后会发 hello，控制窗回一份完整快照。
     注意：这里不关闭 display1 的连接（关掉会让 console1 的后续 CDP 调用阻塞）。 */
  console.log('\n=== 时序：控制窗先做一半，展示窗后开 ===');
  await evalIn(console1, `(function(){
    var D = window.WZ.draft, n = 0;
    while (n < 6 && !D.state().done) {
      var s = D.state();
      if (D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]).ok) n++;
    }
    return D.state().progress;
  })()`);
  const consoleProgress = await evalIn(console1, 'window.WZ.draft.state().progress');
  await sleep(700);

  const res2 = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(fileUrl('index.html', '?wzrole=display'))}`, { method: 'PUT' });
  const display2 = await connectTarget(await res2.json());
  await sleep(4500);

  const late = await evalIn(display2, `JSON.stringify({
    progress: window.WZ.draft.state().progress,
    banFilled: document.querySelectorAll('.ban-slot.filled').length,
    pickFilled: document.querySelectorAll('.pick-slot.filled').length,
    syncText: (document.getElementById('displaySync')||{}).textContent
  })`);
  console.log('· 控制窗进度=' + consoleProgress + '，后开的展示窗：' + late);
  const lateObj = JSON.parse(late);
  check('后开的展示窗自动补齐当前局面', lateObj.progress === consoleProgress,
    '控制窗=' + consoleProgress + ' 展示窗=' + lateObj.progress);
  check('后开的展示窗 ban 位补齐', lateObj.banFilled === 6, 'banFilled=' + lateObj.banFilled);

  console.log('\n' + '='.repeat(48));
  console.log('双窗口同步自检：' + checks + ' 项，失败 ' + failed + ' 项');
  if (!failed) console.log('全部通过 ✓');
  display2.ws.close();
  display1.ws.close();
  console1.ws.close();
} catch (err) {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  code = 1;
} finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
process.exit(code);
