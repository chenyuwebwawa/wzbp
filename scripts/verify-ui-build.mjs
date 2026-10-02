/* ============================================================
   wzbp · 浏览器端 UI 自检（第 1 步：生成测试页）
   ------------------------------------------------------------
   读 index.html，注入 scripts/verify-ui.js 与运行器，输出到
   项目根目录的 _uicheck.html（必须在根目录，否则 index.html 里的
   data/、js/、vendor/ 相对路径解析不到）。
   之后用 headless Chrome 跑：
     chrome --headless=new --dump-dom file:///…/_uicheck.html
   结果在页面里的 <pre id="smokeOut">。

   用法：node scripts/verify-ui-build.mjs
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_uicheck.html');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const runner = `
<pre id="smokeOut" style="display:none"></pre>
<script>
(function () {
  var out = document.getElementById('smokeOut');
  var early = [];
  function dump(lines) {
    out.textContent = lines.join('\\n');
    document.title = 'SMOKE-DONE ' + (lines[0] || '');
  }
  function hard(msg) {
    dump(['SUMMARY | pass=0 fail=1', 'FAIL | harness | ' + msg]);
  }
  window.addEventListener('error', function (e) {
    early.push('EARLY | error: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno);
    hard('onerror: ' + e.message + ' @' + e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    hard('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      var boot = [];
      boot.push('WZ keys: ' + (window.WZ ? Object.keys(window.WZ).join(',') : 'NONE'));
      boot.push('HEROES: ' + (window.WZ && window.WZ.HEROES ? window.WZ.HEROES.length : 'undef'));
      boot.push('hero cards in DOM: ' + document.querySelectorAll('.hero-card').length);
      boot.push('grid hidden: ' + (document.getElementById('heroGrid') || {}).hidden);
      boot.push('side panel: ' + ((document.getElementById('sidePanel') || {}).textContent || '').slice(0, 60));
      boot.push('modeSwitch children: ' + document.querySelectorAll('#modeSwitch button').length);
      boot.push('stepHint: ' + ((document.getElementById('stepHint') || {}).textContent || '').slice(0, 70));
      boot.push('dataStatus: ' + ((document.getElementById('dataStatus') || {}).textContent || '').slice(0, 120));
      if (!window.__SMOKE__) { hard('__SMOKE__ 未定义\\n' + boot.join('\\n') + '\\n' + early.join('\\n')); return; }
      try {
        window.__SMOKE__.run().then(function (lines) {
          dump(boot.map(function (b) { return 'BOOT | ' + b; }).concat(early, lines));
        }, function (err) {
          hard('run() 抛错: ' + (err && err.stack ? err.stack : err) + '\\n' + boot.join('\\n'));
        });
      } catch (err) {
        hard('run() 同步抛错: ' + (err && err.stack ? err.stack : err) + '\\n' + boot.join('\\n'));
      }
    }, 900);
  });
})();
</script>
`;

/* 输出页就在项目根目录，直接引用 scripts/ 下的冒烟脚本 */
html = html.replace('</body>', '<script src="scripts/verify-ui.js"></script>\n' + runner + '\n</body>');
fs.writeFileSync(OUT, html, 'utf8');
console.log('written: _uicheck.html');
