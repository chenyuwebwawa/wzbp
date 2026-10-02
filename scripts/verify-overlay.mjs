/* ============================================================
   wzbp · 赛事面板自检（MVP 卡 / 赛前面板）
   ------------------------------------------------------------
   验证：
     1. 控制窗填数据 → 采集窗（overlay.html）能收到并渲染
     2. 赛前面板自动承接本局 BP 的 5+5 个 pick
     3. 采集窗隐藏控制台、只显示对应那一个覆盖层
     4. 采集页离线可用（不依赖任何 fetch）
     5. 顺带把两张采集画面截图存到 shots/
   用法：node scripts/verify-overlay.mjs
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
  console.error('硬超时（150s），强制退出');
  try { chrome.kill(); } catch (e) { /* 忽略 */ }
  process.exit(4);
}, 150000);
HARD.unref && HARD.unref();

const profile = path.join(process.env.TEMP, 'wzbp-ov-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' });

let checks = 0, failed = 0;
function check(label, cond, detail) {
  checks++;
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (detail ? ' —— ' + detail : '')); }
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
async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = cdpClient(ws);
  await send('Runtime.enable'); await send('Page.enable');
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
  throw new Error('CDP 未就绪');
}
async function evalIn(conn, expr) {
  const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception || {};
    return 'THREW: ' + (ex.description || ex.value || JSON.stringify(r.exceptionDetails));
  }
  return r.result && r.result.value;
}
async function openPage(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return connectTarget(await res.json());
}
const shot = async (conn, name) => {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, 'shots', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('  · 截图已保存 shots/' + name + ' (' + fs.statSync(out).size + ' bytes)');
};

let code = 0;
try {
  /* ---------- 控制窗：填数据 + 打一局 BP ---------- */
  const first = await waitPort();
  const consoleC = await connectTarget(first);
  await consoleC.send('Page.navigate', { url: fileUrl('index.html') });
  await sleep(3200);

  console.log('\n[1] 控制窗写入赛事面板数据');
  const setRes = await evalIn(consoleC, `(function(){
    var S = window.WZ.story;
    S.patch({
      event: '2026 KPL 春季赛', stage: '常规赛 第3周', bestOf: 'BO5',
      mvp: {
        playerId: '一诺', realName: '徐必成', team: '成都AG超玩会', position: '发育路',
        heroId: 112, skinIndex: 0, gameNo: '第一局',
        song: '四分钟越塔强杀，九分钟直捣水晶，全场节奏一手掌控。',
        stats: [
          { label: 'KDA', value: '12/1/8' },
          { label: '输出占比', value: '38%' },
          { label: '参团率', value: '82%' },
          { label: '经济', value: '18.6K' }
        ]
      },
      pre: {
        blue: { name: '成都AG超玩会', winRate: '78%', recent: '5胜1负', rank: '常规赛第1',
                info: [{ label: '场均时长', value: '14:32' }] },
        red:  { name: '重庆狼队', winRate: '71%', recent: '4胜2负', rank: '常规赛第3',
                info: [{ label: '场均时长', value: '15:48' }] },
        h2h: { blueWins: '3', redWins: '2', note: '近 5 次交手，蓝方 3 胜 2 负略占上风' },
        useDraftPicks: true
      }
    });
    S.saveNow();
    return JSON.stringify({ mvpHero: S.get().mvp.heroId, blue: S.get().pre.blue.name });
  })()`);
  check('控制窗数据写入成功', setRes.indexOf('THREW') !== 0, setRes);

  /* 打满一局，制造 5+5 个 pick */
  const draftRes = await evalIn(consoleC, `(function(){
    var D = window.WZ.draft, n = 0;
    D.init('ranked');
    while (!D.state().done && n++ < 30) {
      var s = D.state();
      D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]);
    }
    var st = D.state();
    return JSON.stringify({ step: st.step, picksBlue: st.picks.blue, picksRed: st.picks.red });
  })()`);
  check('控制窗打满一局 BP', JSON.parse(draftRes).step === 16, draftRes);
  const draft = JSON.parse(draftRes);
  await sleep(900);

  /* 赛前面板承接 BP（现在有两条路径，分别验）
     路径 A：BP 变化后由 syncFromDraft 自动跟随（在 onDraftChange 里调用）
     路径 B：手动点「立即用 BP 结果填充空位」强制刷新 */
  console.log('\n[2] 赛前面板自动承接 BP');
  const autoRes = await evalIn(consoleC, `(function(){
    var d = window.WZ.story.get();
    return JSON.stringify({
      blue: d.pre.blue.players.map(function(p){ return p.heroId; }),
      red: d.pre.red.players.map(function(p){ return p.heroId; })
    });
  })()`);
  const auto = JSON.parse(autoRes);
  check('BP 走完后赛前面板自动填满 10 个英雄位（无需手动点）',
    auto.blue.filter(Boolean).length === 5 && auto.red.filter(Boolean).length === 5, autoRes);
  check('自动填充的蓝方与 BP 结果一致',
    JSON.stringify(auto.blue) === JSON.stringify(draft.picksBlue), autoRes);
  check('自动填充的红方与 BP 结果一致',
    JSON.stringify(auto.red) === JSON.stringify(draft.picksRed), autoRes);

  /* 强制刷新路径：force=true 先清空再回填，结果应仍然等于 BP */
  const fillRes = await evalIn(consoleC, `(function(){
    var n = window.WZ.story.applyDraftPicks(true);
    var d = window.WZ.story.get();
    return JSON.stringify({ filled: n,
      blue: d.pre.blue.players.map(function(p){ return p.heroId; }),
      red: d.pre.red.players.map(function(p){ return p.heroId; }) });
  })()`);
  const filled = JSON.parse(fillRes);
  check('强制填充返回 10（先清空再回填）', filled.filled === 10, fillRes);
  check('强制填充后蓝方与 BP 一致',
    JSON.stringify(filled.blue) === JSON.stringify(draft.picksBlue), fillRes);
  check('强制填充后红方与 BP 一致',
    JSON.stringify(filled.red) === JSON.stringify(draft.picksRed), fillRes);

  /* 关键回归（独立验收发现的 R2-1）：
     BP 撤销后，已经不在本局里的英雄必须从赛前面板消失 */
  await evalIn(consoleC, `(function(){
    var D = window.WZ.draft;
    D.undo(); D.undo(); D.undo();
    return 1;
  })()`);
  await sleep(700);
  const afterUndo = JSON.parse(await evalIn(consoleC, `(function(){
    var D = window.WZ.draft, d = window.WZ.story.get();
    var picks = (D.state().picks.blue || []).concat(D.state().picks.red || []).map(String);
    var shown = [];
    ['blue','red'].forEach(function(s){
      d.pre[s].players.forEach(function(p){ if (p.heroId) shown.push(String(p.heroId)); });
    });
    return JSON.stringify({
      draftPicks: picks,
      panelHeroes: shown,
      stale: shown.filter(function(h){ return picks.indexOf(h) === -1; })
    });
  })()`));
  check('撤销后赛前面板不再残留失效英雄（R2-1 回归）',
    afterUndo.stale.length === 0, '残留 = ' + JSON.stringify(afterUndo.stale));
  check('撤销 3 手后面板英雄数随之减少',
    afterUndo.panelHeroes.length === afterUndo.draftPicks.length,
    '面板 ' + afterUndo.panelHeroes.length + ' vs BP ' + afterUndo.draftPicks.length);

  /* 重开后必须全部清空 */
  await evalIn(consoleC, 'window.WZ.draft.reset(); 1');
  await sleep(700);
  const afterReset = JSON.parse(await evalIn(consoleC, `(function(){
    var d = window.WZ.story.get(), shown = 0;
    ['blue','red'].forEach(function(s){
      d.pre[s].players.forEach(function(p){ if (p.heroId) shown++; });
    });
    return JSON.stringify({ shown: shown });
  })()`));
  check('重开后赛前面板英雄位全部清空', afterReset.shown === 0, JSON.stringify(afterReset));

  /* 复原成满局，供后面的采集页断言使用 */
  await evalIn(consoleC, `(function(){
    var D = window.WZ.draft, n = 0;
    while (!D.state().done && n++ < 30) {
      var s = D.state();
      D.apply(s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side, s.stepInfo.action, s.pool[0]);
    }
    return D.state().step;
  })()`);
  await sleep(900);

  /* ---------- MVP 采集窗 ---------- */
  console.log('\n[3] MVP 采集窗');
  const mvpC = await openPage(fileUrl('overlay.html', '?wzrole=overlay&mode=mvp'));
  await sleep(4000);
  const mvpState = JSON.parse(await evalIn(mvpC, `JSON.stringify({
    bodyClass: document.body.className,
    role: window.WZ.sync.role,
    mvpDisplay: getComputedStyle(document.getElementById('mvpOverlay')).display,
    preDisplay: getComputedStyle(document.getElementById('preOverlay')).display,
    flagDisplay: getComputedStyle(document.getElementById('displayFlag')).display,
    hasConsole: !!document.getElementById('console'),
    playerId: document.getElementById('mvpPlayerId').textContent,
    team: document.getElementById('mvpTeam').textContent,
    heroName: document.getElementById('mvpHeroName').textContent,
    event: document.getElementById('mvpEvent').textContent,
    gameNo: document.getElementById('mvpGameNo').textContent,
    statCount: document.querySelectorAll('#mvpStats .mvp-stat').length,
    statText: Array.prototype.map.call(document.querySelectorAll('#mvpStats .mvp-stat'),
      function(n){ return n.querySelector('.ms-label').textContent + '=' + n.querySelector('.ms-value').textContent; }).join('|'),
    song: document.getElementById('mvpSong').textContent.slice(0, 12),
    artSrc: (document.getElementById('mvpArt').getAttribute('src') || '').slice(-30)
  })`));

  check('采集页角色识别为 overlay', mvpState.role === 'overlay', mvpState.role);
  check('只显示 MVP 覆盖层', mvpState.mvpDisplay !== 'none' && mvpState.preDisplay === 'none',
    mvpState.mvpDisplay + '/' + mvpState.preDisplay);
  check('采集页没有控制台元素', mvpState.hasConsole === false);
  check('选手 ID 已渲染', mvpState.playerId === '一诺', mvpState.playerId);
  check('战队已渲染', mvpState.team === '成都AG超玩会', mvpState.team);
  check('赛事名已渲染', mvpState.event === '2026 KPL 春季赛', mvpState.event);
  check('局数已渲染', mvpState.gameNo === '第一局', mvpState.gameNo);
  check('MVP 英雄名已渲染', mvpState.heroName.length > 0, mvpState.heroName);
  check('4 项战绩全部渲染', mvpState.statCount === 4, '实际 ' + mvpState.statCount);
  check('战绩内容正确', mvpState.statText.indexOf('KDA=12/1/8') !== -1, mvpState.statText);
  check('英雄原画已设置', mvpState.artSrc.indexOf('bigskin') !== -1, mvpState.artSrc);
  await shot(mvpC, 'overlay-mvp.png');

  /* R2-2 回归：采集页顶部提示条必须真的显示，两个按钮真的可用 */
  const flagState = JSON.parse(await evalIn(mvpC, `(function(){
    var f = document.getElementById('displayFlag');
    var cs = getComputedStyle(f);
    return JSON.stringify({
      display: cs.display,
      height: Math.round(f.getBoundingClientRect().height),
      btnHideVisible: !!document.getElementById('btnHideFlag').offsetParent,
      btnFitVisible: !!document.getElementById('btnDisplayFit').offsetParent
    });
  })()`));
  check('采集页顶部提示条真的显示（R2-2 回归）', flagState.display !== 'none' && flagState.height > 0,
    JSON.stringify(flagState));
  check('「隐藏提示条」按钮可见可点', flagState.btnHideVisible === true, JSON.stringify(flagState));
  check('「重新适配」按钮可见可点', flagState.btnFitVisible === true, JSON.stringify(flagState));

  /* 点一下隐藏：提示条消失，覆盖层仍然完整落在窗口内 */
  const afterHide = JSON.parse(await evalIn(mvpC, `(function(){
    document.getElementById('btnHideFlag').click();
    window.WZ.overlay.fit();
    var ov = document.getElementById('mvpOverlay');
    var r = ov.getBoundingClientRect();
    return JSON.stringify({
      flagDisplay: getComputedStyle(document.getElementById('displayFlag')).display,
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      vh: window.innerHeight,
      fits: r.top >= -1 && r.bottom <= window.innerHeight + 1
    });
  })()`));
  check('点「隐藏提示条」后提示条消失', afterHide.flagDisplay === 'none', JSON.stringify(afterHide));
  check('隐藏提示条后覆盖层仍完整落在窗口内', afterHide.fits === true, JSON.stringify(afterHide));

  /* 点「重新适配」：提示条回来，覆盖层依然 fits */
  const afterFit = JSON.parse(await evalIn(mvpC, `(function(){
    document.getElementById('btnDisplayFit').click();
    window.WZ.overlay.fit();
    var ov = document.getElementById('mvpOverlay');
    var r = ov.getBoundingClientRect();
    return JSON.stringify({
      flagDisplay: getComputedStyle(document.getElementById('displayFlag')).display,
      top: Math.round(r.top),
      fits: r.top >= -1 && r.bottom <= window.innerHeight + 1
    });
  })()`));
  check('点「重新适配」后提示条恢复显示', afterFit.flagDisplay !== 'none', JSON.stringify(afterFit));
  check('提示条恢复后覆盖层仍完整落在窗口内', afterFit.fits === true, JSON.stringify(afterFit));

  /* ---------- 赛前采集窗 ---------- */
  console.log('\n[4] 赛前采集窗');
  const preC = await openPage(fileUrl('overlay.html', '?wzrole=overlay&mode=pre'));
  await sleep(4000);
  const preState = JSON.parse(await evalIn(preC, `JSON.stringify({
    bodyClass: document.body.className,
    mvpDisplay: getComputedStyle(document.getElementById('mvpOverlay')).display,
    preDisplay: getComputedStyle(document.getElementById('preOverlay')).display,
    blueName: document.querySelector('#preBlue .team-name').textContent,
    redName: document.querySelector('#preRed .team-name').textContent,
    match: document.getElementById('preMatch').textContent,
    bestOf: document.getElementById('preBestOf').textContent,
    bluePlayers: document.querySelectorAll('#preBlue .pre-player').length,
    redPlayers: document.querySelectorAll('#preRed .pre-player').length,
    blueFilled: document.querySelectorAll('#preBlue .pre-player.filled').length,
    redFilled: document.querySelectorAll('#preRed .pre-player.filled').length,
    blueHeroNames: Array.prototype.map.call(document.querySelectorAll('#preBlue .pp-hero'),
      function(n){ return n.textContent; }).join(','),
    h2hShown: getComputedStyle(document.getElementById('preH2h')).display !== 'none',
    h2h: document.getElementById('preH2hBlue').textContent + ':' + document.getElementById('preH2hRed').textContent,
    blueChips: document.querySelectorAll('#preBlue .tm-chip').length,
    artCount: Array.prototype.filter.call(document.querySelectorAll('.pp-art'),
      function(n){ return (n.style.backgroundImage || '').indexOf('bigskin') !== -1; }).length
  })`));

  check('只显示赛前覆盖层', preState.preDisplay !== 'none' && preState.mvpDisplay === 'none',
    preState.preDisplay + '/' + preState.mvpDisplay);
  check('双方队名已渲染',
    preState.blueName === '成都AG超玩会' && preState.redName === '重庆狼队',
    preState.blueName + ' / ' + preState.redName);
  check('对阵标题已渲染', preState.match.length > 0, preState.match);
  check('赛制已渲染', preState.bestOf === 'BO5', preState.bestOf);
  check('双方各 5 个选手位', preState.bluePlayers === 5 && preState.redPlayers === 5,
    preState.bluePlayers + '/' + preState.redPlayers);
  check('10 个位置全部填上英雄（承接 BP）',
    preState.blueFilled === 5 && preState.redFilled === 5,
    preState.blueFilled + '/' + preState.redFilled);
  check('蓝方选手位显示英雄名', preState.blueHeroNames.split(',').filter(Boolean).length === 5,
    preState.blueHeroNames);
  check('交锋史已渲染', preState.h2hShown && preState.h2h === '3:2', preState.h2h);
  check('战队情报 chip 已渲染', preState.blueChips >= 4, '蓝方 ' + preState.blueChips + ' 个');
  check('选手位原画已加载（10 张）', preState.artCount === 10, '实际 ' + preState.artCount);
  await shot(preC, 'overlay-pre.png');

  /* ---------- 实时同步：控制窗改数据，采集窗跟着变 ---------- */
  console.log('\n[5] 实时同步');
  await evalIn(consoleC, `(function(){
    window.WZ.story.setMvp({ playerId: '改过的ID', gameNo: '第三局' });
    window.WZ.storyPanel.broadcastAll();
    return 1;
  })()`);
  await sleep(1500);
  const afterEdit = JSON.parse(await evalIn(mvpC, `JSON.stringify({
    playerId: document.getElementById('mvpPlayerId').textContent,
    gameNo: document.getElementById('mvpGameNo').textContent
  })`));
  check('控制窗改数据后 MVP 采集窗同步更新',
    afterEdit.playerId === '改过的ID' && afterEdit.gameNo === '第三局', JSON.stringify(afterEdit));

  /* 隐藏 / 显示 */
  const hideRes = await evalIn(mvpC, `(function(){
    var raw = window.WZ.story.raw();
    return JSON.stringify({ mvpVisible: raw.mvp.visible });
  })()`);
  check('MVP 覆盖层可见状态字段存在', hideRes.indexOf('mvpVisible') !== -1, hideRes);

  /* ---------- 持久化 ---------- */
  console.log('\n[6] 持久化');
  const persist = JSON.parse(await evalIn(mvpC, `(function(){
    var raw = window.localStorage.getItem('wzbp.story.v1');
    return JSON.stringify({ saved: !!raw, len: raw ? raw.length : 0 });
  })()`));
  check('赛事面板数据已写入 localStorage', persist.saved && persist.len > 100, JSON.stringify(persist));

  console.log('\n' + '='.repeat(52));
  console.log('赛事面板自检：' + checks + ' 项，失败 ' + failed + ' 项');
  if (!failed) console.log('全部通过 ✓');

  consoleC.ws.close(); mvpC.ws.close(); preC.ws.close();
} catch (err) {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  code = 1;
} finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
process.exit(failed ? 1 : code);
