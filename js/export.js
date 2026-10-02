/* ============================================================
   wzbp · 导出 / 导入
   ------------------------------------------------------------
   · 导出 JSON：整局 BP 的完整数据，可再次导入还原
   · 导入：读 JSON 文件重放
   · 截图：用本地 vendored 的 html2canvas 把展示板导成 PNG
     （展示板里的图片来自官网 CDN，带 Access-Control-Allow-Origin: *，
       因此 canvas 可以正常读出像素，不会 tainted）
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var exporter = {};

  function fileBase(kind) {
    var st = WZ.draft.state();
    return 'wzbp-' + st.mode + '-' + kind + '-' + util.stamp();
  }

  /* ------------------------------------------------------------
     导出 JSON
     ------------------------------------------------------------ */
  exporter.exportJSON = function () {
    var st = WZ.draft.state();
    var payload = WZ.draft.exportData();
    payload.summary = buildSummary(st);
    util.download(fileBase('bp') + '.json', JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8');
    if (WZ.app && WZ.app.toast) WZ.app.toast('已导出 BP 数据（JSON）', 'ok');
    return payload;
  };

  function heroName(id) {
    var h = util.heroById(id);
    return h ? h.name : String(id);
  }

  function buildSummary(st) {
    var out = {
      mode: st.modeName,
      steps: st.step + '/' + st.totalSteps,
      blue: { bans: st.bans.blue.map(heroName), picks: st.picks.blue.map(heroName) },
      red: { bans: st.bans.red.map(heroName), picks: st.picks.red.map(heroName) }
    };
    return out;
  }

  /* ------------------------------------------------------------
     导入 JSON 文件
     ------------------------------------------------------------ */
  exporter.importFile = function (file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { done({ ok: false, reason: 'JSON 解析失败' }); return; }
      var res = WZ.draft.importData(data);
      if (res.ok) {
        WZ.draft.clearPending();
        if (WZ.app && WZ.app.toast) WZ.app.toast('已导入 BP：' + res.applied + ' 步', 'ok');
      }
      done(res);
    };
    reader.onerror = function () { done({ ok: false, reason: '文件读取失败' }); };
    reader.readAsText(file, 'utf-8');
  };

  /* ------------------------------------------------------------
     截图导出
     ------------------------------------------------------------ */

  /* 展示板是否被视口裁掉了一部分。
     html2canvas 只可靠地渲染可见区域，窗口太矮（或页面滚动）时截出来会缺内容，
     所以要提前提示用户先切「直播模式」把板子完整展开。 */
  function boardClipped() {
    var frame = document.getElementById('boardFrame');
    if (!frame) return false;
    var r = frame.getBoundingClientRect();
    var vh = window.innerHeight, vw = window.innerWidth;
    return r.top < -1 || r.bottom > vh + 1 || r.left < -1 || r.right > vw + 1;
  }

  exporter.screenshot = function () {
    var board = document.getElementById('board');
    if (!board) return;

    if (typeof window.html2canvas !== 'function') {
      if (WZ.app && WZ.app.toast) {
        WZ.app.toast('缺少 vendor/html2canvas.min.js，截图不可用（其余功能正常）', 'err', 4200);
      }
      return;
    }

    var statusEl = document.getElementById('boardStatus');
    var oldStatus = statusEl ? statusEl.innerHTML : '';
    var finished = false;
    var restoreStatus = function () {
      if (finished) return;
      finished = true;
      if (statusEl) statusEl.innerHTML = oldStatus;
    };

    /* 提示写在展示板自己的状态条上：toast 会被下面那条「正在生成截图…」立刻覆盖，
       写在那里等于用户永远看不到。 */
    var clipped = boardClipped();
    if (statusEl) {
      statusEl.textContent = clipped
        ? '正在生成截图…（展示板未完整显示，建议先点「直播模式」再截图）'
        : '正在生成截图…';
    }

    if (WZ.app && WZ.app.toast) WZ.app.toast('正在生成截图…', '');

    /* 看门狗：html2canvas 少数情况下既不 resolve 也不 reject，
       那样「正在生成截图…」会永久留在状态条上并被 OBS 播出去。 */
    var watchdog = setTimeout(function () {
      if (finished) return;
      restoreStatus();
      if (WZ.app && WZ.app.toast) WZ.app.toast('截图超时（15 秒未完成），已取消，可再试一次', 'err', 4600);
    }, 15000);

    /* 展示板有 transform: scale()，这里显式给出设计尺寸，保证导出 1600×900 */
    window.html2canvas(board, {
      backgroundColor: '#05070c',
      width: 1600,
      height: 900,
      scale: 1,
      /* 官网图片是跨域直链（CDN 带 ACAO:*），必须开 useCORS 才会被画进 canvas；
         千万不能改成 allowTaint:true —— 那样 canvas 会被污染，toBlob 直接抛
         SecurityError。详见 scripts/REPORT-html2canvas.md 的实测对比。 */
      useCORS: true,
      allowTaint: false,
      logging: false,
      imageTimeout: 20000
    }).then(function (canvas) {
      clearTimeout(watchdog);
      /* 看门狗已经判超时并提示「已取消」了：这次迟到的结果直接丢弃，
         否则用户会先看到「超时」，紧接着又收到一个 PNG。 */
      if (finished) return;
      restoreStatus();
      canvas.toBlob(function (blob) {
        if (!blob) {
          if (WZ.app && WZ.app.toast) WZ.app.toast('截图失败：无法生成图片', 'err');
          return;
        }
        util.download(fileBase('shot') + '.png', blob, 'image/png');
        if (WZ.app && WZ.app.toast) WZ.app.toast('截图已保存（1600×900 PNG）', 'ok');
      }, 'image/png');
    }).catch(function (err) {
      clearTimeout(watchdog);
      restoreStatus();
      console.error('[wzbp] screenshot failed', err);
      if (WZ.app && WZ.app.toast) {
        WZ.app.toast('截图失败：' + (err && err.message ? err.message : err), 'err', 4200);
      }
    });
  };

  WZ.exporter = exporter;
})(window.WZ);
