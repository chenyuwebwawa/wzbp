/* ============================================================
   wzbp · 离线可用性自检
   ------------------------------------------------------------
   把官网图床 game.gtimg.cn 解析到黑洞，模拟断网，验证：
     · 控制窗（index.html）仍能操作 BP、搜索、渲染
     · 图片全部降级成首字兜底块，而不是空白/报错
     · 采集页（overlay.html 的 MVP 卡 / 赛前面板）仍能出画面
     · 全程没有未捕获异常
   用法：node scripts/verify-offline.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NO_PROXY = '127.0.0.1,localhost';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9100 + Math.floor(Math.random() * 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p, q) => 'file:///' + path.join(ROOT, p).split(path.sep).join('/') + (q || '');

const HARD = setTimeout(() => {
  console.error('硬超时（180s），强制退出');
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(4);
}, 180000);
HARD.unref && HARD.unref();

const profile = path.join(process.env.TEMP, 'wzbp-offline-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900',
  /* 关键：这台机器有系统代理，代理会绕过 host-resolver-rules，
     图片照样从真网加载（实测 fallbacks=0，断网根本没生效）。
     必须同时强制直连，host-resolver-rules 才会真正命中。 */
  '--proxy-server=direct://',
  '--proxy-bypass-list=*',
  /* 把官网图床指到黑洞 = 完全断图，但本地文件与数据不受影响 */
  '--host-resolver-rules=MAP game.gtimg.cn 127.0.0.1',
  'about:blank'
], { stdio: 'ignore' });

let checks = 0, failed = 0;
function check(label, cond, detail) {
  checks++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (!cond && detail ? ' —— ' + detail : ''));
  if (!cond) failed++;
}

function cdpClient(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}

/* 关键：用 CDP 在新文档里注入错误钩子。
   之前是在控制窗里 window.addEventListener，但采集页不加载 main.js，
   钩子根本不会执行，等于「零错误」是假的。 */
async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdpClient(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  /* 用 CDP 在「请求发出之前」就拦掉图床 —— 比 host-resolver-rules 可靠得多：
     这台机器有系统代理，光靠域名解析会被代理绕过（实测只有 11 张图被拦住）。 */
  try {
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*game.gtimg.cn*', '*pvp.qq.com*'] });
  } catch (e) {
    console.log('  （提示：Network.setBlockedURLs 不可用，退回 host-resolver-rules 生效范围）');
  }
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      window.addEventListener('error', function (e) { window.__errs.push('err: ' + e.message); });
      window.addEventListener('unhandledrejection', function (e) {
        window.__errs.push('rej: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
      });`
  });
  return { ws, send };
}

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((x) => x.type === 'page');
      if (p) return p;
    } catch (e) { /* wait */ }
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
async function openPage(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return connectTarget(await res.json());
}

/* 退出码必须反映真实结果：把 code 提到 try 外面，
   否则 process.exit 在作用域外拿不到它，会永远返回 0（假绿）。 */
let code = 0;
try {
  /* ---------- 控制窗（离线） ---------- */
  console.log('\n[1] 控制窗在断图环境下');
  const c = await connectTarget(await waitPort());
  await c.send('Page.navigate', { url: fileUrl('index.html') });
  await sleep(4000);

  const consoleState = JSON.parse(await evalIn(c, `(function(){
    var D = window.WZ.draft, n = 0;
    D.init('ranked');
    while (n < 6 && !D.state().done) {
      var s = D.state();
      if (D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]).ok) n++;
    }
    return JSON.stringify({
      heroes: (window.WZ.HEROES || []).length,
      steps: D.state().step,
      progress: D.state().progress,
      banFilled: document.querySelectorAll('.ban-slot.filled').length,
      cards: document.querySelectorAll('.hero-card').length,
      failedImgs: document.querySelectorAll('img.img-failed').length,
      fallbacks: document.querySelectorAll('.img-fallback').length,
      search: window.WZ.util.searchHeroes('lianpo')[0] ? window.WZ.util.searchHeroes('lianpo')[0].name : '',
      errs: (window.__errs || []).length
    });
  })()`));
  check('离线：133 位英雄数据照常加载', consoleState.heroes === 133, String(consoleState.heroes));
  check('离线：BP 仍能操作（6 步）', consoleState.progress === 6, String(consoleState.progress));
  check('离线：展示板 DOM 照常更新', consoleState.banFilled === 6, String(consoleState.banFilled));
  check('离线：英雄卡全部渲染', consoleState.cards === 133, String(consoleState.cards));
  check('离线：搜索仍可用', consoleState.search === '廉颇', consoleState.search);
  check('离线：失败的图降级为首字兜底块', consoleState.fallbacks > 100,
    'failedImgs=' + consoleState.failedImgs + ' fallbacks=' + consoleState.fallbacks);
  check('离线：控制窗无未捕获异常', consoleState.errs === 0, String(consoleState.errs));

  /* 写入赛事面板数据，供采集页读取（走 localStorage，不依赖网络） */
  await evalIn(c, `(function(){
    window.WZ.story.patch({
      event: '离线测试赛', stage: '第1周',
      mvp: { playerId: '离线选手', team: '测试队', heroId: 105, gameNo: '第一局',
             song: '断网也要能放。',
             stats: [{label:'KDA',value:'1/0/0'},{label:'经济',value:'9.9K'}] },
      pre: { blue: { name: '离线蓝队' }, red: { name: '离线红队' },
             h2h: { blueWins: '1', redWins: '1' } }
    });
    window.WZ.story.saveNow();
    return 1;
  })()`);
  await sleep(700);

  /* ---------- MVP 采集页（离线） ---------- */
  console.log('\n[2] MVP 卡在断图环境下');
  const mvp = await openPage(fileUrl('overlay.html', '?wzrole=overlay&mode=mvp'));
  await sleep(4500);
  const m = JSON.parse(await evalIn(mvp, `JSON.stringify({
    playerId: document.getElementById('mvpPlayerId').textContent,
    event: document.getElementById('mvpEvent').textContent,
    heroName: document.getElementById('mvpHeroName').textContent,
    song: document.getElementById('mvpSong').textContent.slice(0, 6),
    stats: document.querySelectorAll('#mvpStats .mvp-stat').length,
    natW: document.getElementById('mvpArt').naturalWidth,
    mvpShown: getComputedStyle(document.getElementById('mvpOverlay')).display !== 'none',
    errs: (window.__errs || []).length
  })`));
  check('离线：MVP 采集成画面', m.mvpShown);
  check('离线：选手 ID 仍渲染', m.playerId === '离线选手', m.playerId);
  check('离线：赛事名仍渲染', m.event === '离线测试赛', m.event);
  check('离线：英雄名来自本地数据', m.heroName === '廉颇', m.heroName);
  check('离线：战绩仍渲染', m.stats === 2, String(m.stats));
  check('离线：原画确实没加载（证明真的断网了）', m.natW === 0, String(m.natW));
  check('离线：MVP 页无未捕获异常', m.errs === 0, String(m.errs));

  /* ---------- 赛前采集页（离线） ---------- */
  console.log('\n[3] 赛前面板在断图环境下');
  const pre = await openPage(fileUrl('overlay.html', '?wzrole=overlay&mode=pre'));
  await sleep(4500);
  const p = JSON.parse(await evalIn(pre, `JSON.stringify({
    blue: document.querySelector('#preBlue .team-name').textContent,
    red: document.querySelector('#preRed .team-name').textContent,
    players: document.querySelectorAll('#preBlue .pre-player').length,
    h2h: document.getElementById('preH2hBlue').textContent + ':' + document.getElementById('preH2hRed').textContent,
    preShown: getComputedStyle(document.getElementById('preOverlay')).display !== 'none',
    errs: (window.__errs || []).length
  })`));
  check('离线：赛前采集成画面', p.preShown);
  check('离线：双方队名仍渲染', p.blue === '离线蓝队' && p.red === '离线红队', p.blue + '/' + p.red);
  check('离线：5 个选手位仍在', p.players === 5, String(p.players));
  check('离线：交锋史仍渲染', p.h2h === '1:1', p.h2h);
  check('离线：赛前页无未捕获异常', p.errs === 0, String(p.errs));

  console.log('\n' + '='.repeat(50));
  console.log('离线可用性自检：' + checks + ' 项，失败 ' + failed + ' 项');
  if (!failed) console.log('全部通过 ✓');

  c.ws.close(); mvp.ws.close(); pre.ws.close();
} catch (err) {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  code = 1;
} finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
process.exit(failed ? 1 : code);
