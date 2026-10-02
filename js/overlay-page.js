/* ============================================================
   wzbp · 采集页启动（overlay.html?mode=mvp|pre）
   ------------------------------------------------------------
   这一页只做两件事：
     1. 渲染控制窗广播过来的赛事面板数据
     2. 自己处理缩放与提示条隐藏
   所有编辑都在控制窗完成，这里不写任何本地存档。
   ============================================================ */
(function () {
  'use strict';

  var MODE = (/[?&]mode=([a-z]+)/.exec(location.search) || [])[1] || 'mvp';

  function boot() {
    var WZ = window.WZ;
    WZ.overlay.init();
    WZ.overlay.setMode(MODE);

    /* 隐藏另一个覆盖层，只留当前模式 */
    if (MODE === 'mvp') {
      var pre = document.getElementById('preOverlay');
      if (pre) pre.style.display = 'none';
    } else {
      var mvp = document.getElementById('mvpOverlay');
      if (mvp) mvp.style.display = 'none';
    }
    document.title = '采集画面 · ' + (MODE === 'mvp' ? 'MVP 卡' : '赛前面板');

    /* 先把本地存档铺上，避免打开瞬间空白 */
    WZ.story.load();
    WZ.overlay.renderFor(MODE, WZ.story.get());

    /* 数据变化（控制窗同步过来 / 本地表单）都重绘 */
    WZ.story.on(function (d) { WZ.overlay.renderFor(MODE, d); });

    /* 本局 BP 的 pick 也要能补进赛前面板的空位：
       draft 状态变了同样重绘。 */
    if (WZ.draft) {
      WZ.draft.on(function () {
        if (MODE === 'pre') WZ.overlay.renderFor(MODE, WZ.story.get());
      });
    }

    /* ---- 顶部提示条 ---- */
    var flag = document.getElementById('displayFlag');
    var syncEl = document.getElementById('displaySync');
    var btnHide = document.getElementById('btnHideFlag');
    var btnFit = document.getElementById('btnDisplayFit');

    if (btnHide) {
      btnHide.addEventListener('click', function () {
        if (flag) flag.classList.add('flag-hidden');
        WZ.overlay.fit();
        setTimeout(function () { WZ.overlay.fit(); }, 60);
      });
    }
    if (btnFit) {
      btnFit.addEventListener('click', function () {
        if (flag) flag.classList.remove('flag-hidden');
        WZ.overlay.fit();
        setTimeout(function () { WZ.overlay.fit(); }, 60);
      });
    }

    /* ---- 与控制窗同步 ---- */
    var sync = WZ.sync;
    sync.start();
    sync.on(function (type, msg) {
      if (type === 'hello') {
        /* 采集页上线：告诉控制窗「把当前数据发我」 */
        if (syncEl) syncEl.textContent = '等待控制窗数据…';
        return;
      }
      if (type === 'overlay' && msg.payload) {
        WZ.story.importData({ data: msg.payload.story });
        WZ.overlay.renderFor(MODE, WZ.story.get());
        if (syncEl) {
          syncEl.textContent = '已同步 · ' +
            new Date().toLocaleTimeString('zh-CN', { hour12: false });
        }
        return;
      }
      if (type === 'snapshot' || type === 'update') {
        if (msg.payload && msg.payload.story) {
          WZ.story.importData({ data: msg.payload.story });
          WZ.overlay.renderFor(MODE, WZ.story.get());
        }
        if (syncEl) syncEl.textContent = '已连接控制窗';
      }
    });

    /* 上线后主动要一次数据 */
    setTimeout(function () { sync.post({ t: 'hello' }); }, 150);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
