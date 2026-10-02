/* ============================================================
   wzbp · 应用主控
   ------------------------------------------------------------
   把 引擎 / 控制台 / 展示板 / 导出 串起来，并负责：
   快捷键、倒计时、直播模式、URL 分享码、本地草稿恢复。
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var app = {};
  var draft = WZ.draft;
  var sync = WZ.sync;

  var dom = {};
  var manualFocus = null;          // 手动预览的英雄 {hero, slotLabel, side, skin}
  var timer = { total: 0, left: 0, running: false, id: null };
  var isDisplay = false;           // 本窗口是不是「展示窗」
  var suppressBroadcast = false;   // 收到远端消息时不要再回播，避免来回弹

  var LS_DRAFT = 'wzbp.draft.v1';
  var LS_PREFS = 'wzbp.prefs.v1';

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */
  app.start = function () {
    isDisplay = sync.isDisplay();
    document.body.classList.toggle('role-display', isDisplay);

    dom.modeSwitch = document.getElementById('modeSwitch');
    dom.stepHint = document.getElementById('stepHint');
    dom.dataStatus = document.getElementById('dataStatus');
    dom.clock = document.getElementById('clock');
    dom.boardClock = document.getElementById('boardClock');
    dom.toast = document.getElementById('toast');
    dom.displaySync = document.getElementById('displaySync');

    if (!dom.boardClock) dom.boardClock = util.el('div', 'board-timer idle', '00:00');

    reportDataStatus();

    /* 引擎必须先初始化：控制台与展示板在构建时就会读取 BP 状态 */
    draft.init(prefMode());

    /* 先建展示板骨架，再建控制台 */
    WZ.board.init();
    WZ.ui.init();

    /* 注意：bindKeys() 与 draft.on() 只能注册一次。
       之前 startAsConsole() 里也各写了一份，导致 Ctrl+Z 一次退两步、
       空格/Ctrl+B 被重复处理而看起来失效、每次动作 render 与广播都跑两遍。 */
    bindKeys();
    draft.on(onDraftChange);

    if (isDisplay) {
      startAsDisplay();
    } else {
      startAsConsole();
    }

    sync.start();
    bindSync();

    resizeBoard();
    window.addEventListener('resize', util.debounce(resizeBoard, 120));
  };

  /* ---------- 控制窗：正常功能 + 广播 ---------- */
  function startAsConsole() {
    buildModeSwitch();
    bindControls();

    /* 赛事面板：先加载本地存档，再建表单 */
    WZ.story.load();
    WZ.overlay.init();
    WZ.overlay.render(WZ.story.get());
    WZ.storyPanel.init();
    WZ.story.on(function (d) {
      WZ.overlay.render(d);
      pushTeamNames();               // 赛前面板里改了队名 → 展示板立刻跟着变
      broadcastOverlayToCollectors();
    });

    /* 战队名输入框（展示板上方，直播时随手改） */
    buildTeamNameBar();
    pushTeamNames();

    /* 联网：探测服务端；不可用则静默保持纯静态模式 */
    initOnline();

    /* 启动时尝试恢复：URL 分享码 > 本地草稿 > 保持全新的初始状态 */
    var restored = restoreFromUrl() || restoreLocalDraft();
    if (!restored) {
      draft.reset();
      toast('搜索英雄名或拼音，点英雄后选择 ban/pick；直播请点「打开展示窗」', 'ok', 4600);
    }
    window.addEventListener('hashchange', function () { restoreFromUrl(true); });
  }

  /* ------------------------------------------------------------
     联网模式接线
     ------------------------------------------------------------
     设计要点：
       · 联网时**服务端是权威**：本机落子走 POST /action，盘面由 SSE 下发的
         state 驱动重建；不再让本地 draft 自行推进，避免两边各走一套。
       · 离线时一切照旧（本地 draft + sync.js 跨窗口同步）。
       · 房间顺序（随机征召）通过 draft.setOrder() 注入引擎；
         全局 BP 池通过 draft.setGlobalUsed() 注入，UI 据此标灰。 */

  var online = { active: false, code: null, lastState: null, launched: false };

  function initOnline() {
    if (!WZ.net || typeof WZ.net.init !== 'function') return;
    try {
      /* 先探测服务端；net.init 幂等，roomUI.init 内部再调也不会重复探测 */
      var p = WZ.net.init();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          online.active = !!(WZ.net.isOnline && WZ.net.isOnline());
          if (online.active) toast('已连接服务器，点顶部「房间」可以开房多人 BP', 'ok', 4200);
        });
      }

      if (WZ.roomUI && typeof WZ.roomUI.init === 'function') {
        WZ.roomUI.init({
          onState: applyServerState,
          onError: function (err) { if (err && err.message) toast(err.message, 'err'); }
        });
      }
      if (WZ.replayUI && typeof WZ.replayUI.init === 'function') WZ.replayUI.init();
    } catch (e) {
      console.error('[wzbp] 联网模块初始化失败（已降级为纯静态模式）', e);
      return;
    }

    if (WZ.net.onStatus) {
      WZ.net.onStatus(function (st) { online.active = !!(st && st.online); });
    }
  }

  /* 服务端权威状态 → 重建本地引擎与盘面 */
  function applyServerState(state) {
    if (!state || !state.room) return;
    online.active = true;
    online.code = state.room.code;
    online.lastState = state;

    var game = state.game || {};
    var series = state.series || {};

    /* 1) 顺序蓝图：随机征召等服务端下发的顺序要注入引擎 */
    if (series.order && series.order.length) {
      draft.setOrder(series.order, state.room.mode, { global: !!game.global });
    } else if (state.room.mode !== draft.state().mode) {
      draft.init(state.room.mode);
    }

    /* 2) 全局 BP 池
       注意顺序：服务端的 globalUsed 是「整个系列赛累计，含当前小局已选」。
       如果先注入再重放本局 actions，本局自己的 pick 会撞上「全局已用」而被拒，
       重放循环就会中断、盘面停在 ban 阶段（真库路径实测过的阻断 bug）。
       所以：重放期间先清空全局池，重放完再注回。
       本局内的重复由引擎的 taken() 兜住，不会漏校验。 */
    var globalNow = game.globalUsed || { blue: [], red: [] };
    draft.setGlobalUsed({ blue: [], red: [] });

    /* 3) 用动作流水把盘面重放到第 N 手（服务端 actions 是权威） */
    var acts = state.actions || [];
    var cur = draft.state();
    if (!cur || cur.progress !== acts.length) {
      draft.reset(draft.state().mode);
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        var r = draft.apply(a.side, a.action, a.heroId);
        if (!r.ok) {
          /* 服务端与本地引擎不一致时不要死循环，也不要静默——报出来 */
          console.error('[wzbp] 回放服务端动作失败', a, r.reason);
          break;
        }
      }
      /* 中央大图跟到最后一手 */
      if (acts.length) {
        var last = acts[acts.length - 1];
        var st2 = draft.state();
        var arr = last.action === 'ban' ? st2.bans[last.side] : st2.picks[last.side];
        WZ.board.markPlaced(last.action, last.side, arr.length - 1);
      }
    }

    /* 3.5) 重放完再把全局池注回，UI 据此把「本方之前小局用过」的英雄标灰 */
    draft.setGlobalUsed(globalNow);

    /* 4) v3：管理员没点「开始 BP」之前，本机所有操作都锁住
          （服务端也会拒，这里锁住是为了让用户看得懂，而不是点了没反应） */
    var launched = !!state.room.launched;
    online.launched = launched;
    if (WZ.ui.setLocked) {
      WZ.ui.setLocked(online.active && online.code && !launched,
        '等待管理员开始 BP —— 现在是「加入队伍」阶段，开局后才能 ban/pick');
    }

    WZ.ui.syncTakenFlags();
    WZ.ui.syncActions();
  }

  /* 联网时本机落子：交给服务端，等 SSE 回来再改盘面 */
  function sendActionOnline(side, action, hero) {
    if (!WZ.roomUI || typeof WZ.roomUI.sendAction !== 'function') return false;
    WZ.roomUI.sendAction(side, action, hero.id).catch(function (err) {
      toast((err && err.message) || '操作失败', 'err');
    });
    return true;
  }

  /* 赛事面板数据变化 → 推给采集窗（节流，避免每敲一个字都发） */
  var pushOverlaySoon = util.debounce(function () {
    if (typeof WZ.storyPanel.broadcastAll === 'function') WZ.storyPanel.broadcastAll();
  }, 220);
  function broadcastOverlayToCollectors() { pushOverlaySoon(); }

  /* ---------- 展示窗：只做展示，所有操作来自控制窗 ---------- */
  function startAsDisplay() {
    /* 展示窗不提供控制台，也不写本地草稿；状态全部靠同步消息驱动 */
    buildModeSwitch();
    document.getElementById('btnOpenDisplay').style.display = 'none';
    document.getElementById('btnBossMode').style.display = 'none';
    document.getElementById('btnImportJson').style.display = 'none';
    document.getElementById('btnReset').style.display = 'none';
    document.getElementById('btnUndo').style.display = 'none';
    document.getElementById('btnRedo').style.display = 'none';
    document.getElementById('importFile').disabled = true;

    document.getElementById('btnDisplayFit').addEventListener('click', function () {
      WZ.board.fit();
    });

    /* 先把本地可能存在的草稿铺上，避免打开瞬间是空板 */
    restoreLocalDraft(true);

    /* 展示窗只管自己这一屏的缩放 */
    window.addEventListener('resize', util.debounce(function () {
      WZ.board.fit();
      if (dom.boardClock) dom.boardClock.textContent = dom.boardClock.textContent;
    }, 150));
  }

  function reportDataStatus() {
    var meta = WZ.HERO_META || {};
    var n = (WZ.HEROES || []).length;
    var skills = WZ.SKILLS ? Object.keys(WZ.SKILLS).length : 0;
    var bits = [];
    if (n) bits.push('英雄 ' + n);
    if (skills) bits.push('技能 ' + skills);
    if (meta.generatedAt) bits.push('数据日期 ' + meta.generatedAt);
    if (!n) {
      dom.dataStatus.textContent = '⚠ 未加载 data/heroes.js，请先运行 scripts 下的生成脚本';
      dom.dataStatus.style.color = '#ffc7ce';
    } else {
      dom.dataStatus.textContent = bits.join(' · ') + ' · 来源：王者荣耀官网';
    }
  }

  /* ------------------------------------------------------------
     赛制切换
     ------------------------------------------------------------ */
  /* ------------------------------------------------------------
     战队名输入条
     ------------------------------------------------------------
     写在控制台顶部，改完立刻出现在展示板上（并同步到展示窗）。
     存进赛前面板的 pre.blue.name / pre.red.name，与「赛前面板」共用一份数据。 */
  function buildTeamNameBar() {
    var host = document.getElementById('teamNameBar');
    if (!host) return;
    host.innerHTML = '';

    var names = currentTeamNames();
    [['blue', '蓝方战队名', names.blue], ['red', '红方战队名', names.red]].forEach(function (it) {
      var side = it[0];
      var wrap = util.el('label', 'tnb-item tnb-' + side);
      wrap.appendChild(util.el('span', 'tnb-tag', side === 'blue' ? '蓝' : '红'));
      var input = util.el('input', 'tnb-input');
      input.type = 'text';
      input.maxLength = 24;
      input.value = it[2];
      input.placeholder = it[1];
      input.id = 'tnbInput-' + side;
      input.addEventListener('input', function () { setTeamName(side, input.value); });
      wrap.appendChild(input);
      host.appendChild(wrap);
    });
    host.hidden = false;
  }
  app.buildTeamNameBar = buildTeamNameBar;

  function buildModeSwitch() {
    dom.modeSwitch.innerHTML = '';
    draft.MODES.forEach(function (m) {
      var btn = util.el('button', '');
      btn.type = 'button';
      btn.dataset.mode = m.id;
      btn.appendChild(document.createTextNode(m.name));
      if (m.experimental) btn.appendChild(util.el('small', '', '·测试'));
      btn.title = m.desc;
      dom.modeSwitch.appendChild(btn);
    });
    dom.modeSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      var mode = btn.dataset.mode;
      if (mode === draft.state().mode) return;
      if (hasProgress() && !window.confirm('切换赛制会清空当前 BP，确定吗？')) return;
      savePref({ mode: mode });
      manualFocus = null;
      draft.init(mode);
      toast('已切换到「' + draft.modeById(mode).name + '」', 'ok');
    });
    syncModeSwitch();
  }

  function syncModeSwitch() {
    var cur = draft.state().mode;
    util.$$('button', dom.modeSwitch).forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === cur);
    });
  }

  /* ------------------------------------------------------------
     控件绑定
     ------------------------------------------------------------ */
  function bindControls() {
    document.getElementById('btnUndo').addEventListener('click', doUndo);
    document.getElementById('btnRedo').addEventListener('click', doRedo);
    document.getElementById('btnReset').addEventListener('click', doReset);

    document.getElementById('btnTimer30').addEventListener('click', function () { setTimer(30); startTimer(); });
    document.getElementById('btnTimer60').addEventListener('click', function () { setTimer(60); startTimer(); });
    document.getElementById('btnTimerStart').addEventListener('click', toggleTimer);
    document.getElementById('btnTimerReset').addEventListener('click', function () { stopTimer(); setTimer(0); });

    document.getElementById('btnExportJson').addEventListener('click', function () { WZ.exporter.exportJSON(); });
    document.getElementById('btnImportJson').addEventListener('click', function () {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      WZ.exporter.importFile(f, function (res) {
        if (res.ok) toast('已导入 BP：' + res.applied + ' 步', 'ok');
        else toast('导入失败：' + res.reason, 'err');
      });
      e.target.value = '';
    });
    document.getElementById('btnScreenshot').addEventListener('click', function () { WZ.exporter.screenshot(); });
    document.getElementById('btnShare').addEventListener('click', openShare);
    document.getElementById('btnBossMode').addEventListener('click', function () { toggleBoss(); });
    document.getElementById('btnOpenDisplay').addEventListener('click', openDisplayWindow);

    document.getElementById('btnShareCopy').addEventListener('click', function () {
      var ta = document.getElementById('shareText');
      ta.select();
      util.copyText(ta.value).then(function () { toast('分享码已复制', 'ok'); },
        function () { toast('复制失败，请手动选中复制', 'warn'); });
    });
    document.getElementById('btnShareClose').addEventListener('click', function () {
      document.getElementById('shareModal').hidden = true;
    });
    document.getElementById('shareModal').addEventListener('click', function (e) {
      if (e.target.id === 'shareModal') e.currentTarget.hidden = true;
    });
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea';

      /* 撤销/重做：输入框里也允许 */
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault(); doUndo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' ||
          (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault(); doRedo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault(); toggleBoss(); return;
      }
      if (typing) return;

      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggleTimer(); return; }
      if (e.key === '/') { e.preventDefault(); document.getElementById('searchInput').focus(); return; }
      if (e.key === 'Escape') {
        if (document.body.classList.contains('boss')) toggleBoss();
        return;
      }
      if (e.key === 'Enter' && !document.getElementById('shareModal').hidden) {
        document.getElementById('shareModal').hidden = true;
      }
    });
  }

  /* ------------------------------------------------------------
     BP 动作
     ------------------------------------------------------------ */
  app.onAction = function (side, action, hero) {
    if (!hero) return;

    /* v3：管理员没开局前一律不接（联网时服务端也会拒，这里给出人话提示） */
    if (online.active && online.code && !online.launched) {
      toast('还没开始 BP —— 等管理员点「开始 BP」（现在先加入队伍）', 'warn', 3600);
      return;
    }

    /* 联网且已在房间内：服务端是权威，本机只发请求，盘面等 SSE 回来重建 */
    if (online.active && online.code) {
      if (sendActionOnline(side, action, hero)) return;
    }

    var res = draft.apply(side, action, hero.id);
    if (!res.ok) { toast(res.reason, 'err'); return; }
    manualFocus = null;
    var st = draft.state();
    var arr = action === 'ban' ? st.bans[side] : st.picks[side];
    WZ.board.markPlaced(action, side, arr.length - 1);
    /* 未开始的选择动作：自动开表（方便直播） */
    if (!timer.running && timer.total > 0) startTimer();
    saveLocalDraft();
  };

  function doUndo() {
    /* 联网时撤销也走服务端，保证别人看到的和你一致（撤销接口在 net 上，不在 roomUI） */
    if (online.active && online.code && WZ.net && typeof WZ.net.undo === 'function') {
      WZ.net.undo(online.code).catch(function (err) {
        toast((err && err.message) || '撤销失败', 'warn');
      });
      return;
    }
    var r = draft.undo();
    if (!r.ok) { toast(r.reason, 'warn'); return; }
    manualFocus = null;
    WZ.board.clearPlaced();
    saveLocalDraft();
    toast('已撤销上一步', 'ok');
  }

  function doRedo() {
    var r = draft.redo();
    if (!r.ok) { toast(r.reason, 'warn'); return; }
    manualFocus = null;
    WZ.board.clearPlaced();
    saveLocalDraft();
    toast('已重做', 'ok');
  }

  function doReset() {
    if (hasProgress() && !window.confirm('确定清空当前 BP 并重新开始吗？')) return;
    manualFocus = null;
    WZ.board.clearPlaced();
    stopTimer();
    setTimer(0);
    draft.reset();
    util.store.del(LS_DRAFT);
    toast('已重开', 'ok');
  }

  function hasProgress() {
    var s = draft.state();
    return !!(s && s.progress);
  }

  /* ------------------------------------------------------------
     双窗口（直播时的推荐用法）
     ------------------------------------------------------------
     控制窗：操作 BP（搜索、ban/pick、撤销、计时）
     展示窗：?wzrole=display，只有展示板，用 OBS 采集它
     两个窗口同源，靠 BroadcastChannel + localStorage 事件同步。 */

  function displayUrl() {
    var base = location.href.split('#')[0].split('?')[0];
    return base + '?wzrole=display';
  }

  function openDisplayWindow() {
    var feat = 'width=1280,height=760,menubar=no,toolbar=no,location=no,status=no';
    var w = window.open(displayUrl(), 'wzbp-display', feat);
    if (!w) {
      toast('浏览器拦截了新窗口，请允许本站弹窗后重试', 'err', 4200);
      return;
    }
    try { w.focus(); } catch (e) { /* 忽略 */ }
    toast('展示窗已打开：把 OBS「窗口采集」指向它，这个窗口继续操作 BP', 'ok', 5200);
    /* 新窗口上线后会发 hello，届时再回一份完整快照 */
  }

  /* 打包一份完整状态给展示窗 / 采集窗 */
  function snapshotPayload() {
    var st = draft.state();
    var heroes = WZ.HEROES || [];
    return {
      mode: st ? st.mode : undefined,
      actions: (function () {
        try { return draft.exportData().actions; } catch (e) { return []; }
      })(),
      heroCount: heroes.length,
      timer: { total: timer.total, left: timer.left, running: timer.running },
      /* 战队名：展示窗也要显示（直播画面上「蓝方是哪支队」） */
      teamNames: currentTeamNames(),
      /* 赛事面板数据：采集窗上线时一并补齐 */
      story: (WZ.story && typeof WZ.story.get === 'function') ? WZ.story.get() : null,
      present: manualFocus ? {
        heroId: manualFocus.hero.id,
        skinIndex: manualFocus.skinIndex,
        slotLabel: manualFocus.slotLabel,
        side: manualFocus.side || ''
      } : null
    };
  }

  /* 战队名统一从「赛前面板」的蓝/红队名取，避免两处各填一份对不上 */
  function currentTeamNames() {
    try {
      var d = WZ.story && WZ.story.get ? WZ.story.get() : null;
      var pre = (d && d.pre) || {};
      return {
        blue: (pre.blue && pre.blue.name) || '',
        red: (pre.red && pre.red.name) || ''
      };
    } catch (e) {
      return { blue: '', red: '' };
    }
  }

  /* 把战队名刷到展示板上（控制窗与展示窗都会调） */
  function pushTeamNames(names) {
    if (!WZ.board || typeof WZ.board.setTeamNames !== 'function') return;
    WZ.board.setTeamNames(names || currentTeamNames());
  }

  /* 快速改战队名：直接写进赛前面板的数据（唯一数据源），两处界面同步更新 */
  function setTeamName(side, name) {
    if (!WZ.story || typeof WZ.story.patch !== 'function') return;
    var clean = String(name || '').trim().slice(0, 24);
    var patch = { pre: {} };
    patch.pre[side] = { name: clean };
    WZ.story.patch(patch);
    pushTeamNames();
    broadcastOverlayToCollectors();
    broadcastSnapshot('update');
  }
  app.setTeamName = setTeamName;
  /* 同步载荷快照：自检脚本用它验证「展示窗能拿到什么」 */
  app.snapshotForTest = snapshotPayload;

  function broadcastSnapshot(type) {
    if (isDisplay || suppressBroadcast || !sync) return;
    sync.post({ t: type || 'update', payload: snapshotPayload() });
  }

  /* 展示窗收到状态后照着重放（不广播、不写本地草稿、不更新 URL） */
  function applyRemoteSnapshot(payload) {
    if (!payload) return;
    suppressBroadcast = true;
    try {
      if (payload.heroCount && (!WZ.HEROES || WZ.HEROES.length !== payload.heroCount)) return;
      var acts = Array.isArray(payload.actions) ? payload.actions : [];
      var res;
      if (!acts.length) {
        /* 「重开」广播过来的就是空动作 + 赛制：直接用 reset，
           不能走 importData —— 空 actions 会被当成非法文件拒绝。 */
        draft.reset(payload.mode);
        res = { ok: true, applied: 0 };
      } else {
        res = draft.importData({ app: 'wzbp', version: 1, mode: payload.mode, actions: acts });
      }
      if (res && res.ok && typeof payload.timer === 'object') {
        timer.total = payload.timer.total || 0;
        timer.left = payload.timer.left || 0;
        timer.running = false;
        renderTimer();
      }
      if (payload.present) {
        var h = util.heroById(payload.present.heroId);
        if (h) {
          manualFocus = {
            hero: h, slotLabel: payload.present.slotLabel || '预览',
            side: payload.present.side || '', skinIndex: payload.present.skinIndex || 0
          };
          WZ.board.showHero(h, manualFocus.slotLabel, manualFocus.side, manualFocus.skinIndex);
        }
      }
      /* 战队名：载荷里带了就用载荷的（展示窗本地没有 story 编辑权） */
      if (payload.teamNames) {
        pushTeamNames(payload.teamNames);
      } else if (payload.story && payload.story.pre) {
        pushTeamNames({
          blue: (payload.story.pre.blue && payload.story.pre.blue.name) || '',
          red: (payload.story.pre.red && payload.story.pre.red.name) || ''
        });
      }
      setDisplaySync('已同步 · ' + (draft.state() ? draft.state().progress : 0) + ' 步');
      WZ.board.fit();
    } finally {
      suppressBroadcast = false;
    }
  }

  function setDisplaySync(text) {
    if (dom.displaySync) dom.displaySync.textContent = text;
  }

  function bindSync() {
    if (!sync) return;
    sync.on(function (type, msg) {
      if (type === 'hello') {
        /* 展示窗上线：控制窗回一份完整快照 */
        if (!isDisplay) broadcastSnapshot('snapshot');
        else setDisplaySync('我是展示窗');
        return;
      }
      if (type === 'snapshot' || type === 'update') {
        if (isDisplay) applyRemoteSnapshot(msg.payload);
        else setDisplaySync('展示窗在线');
        return;
      }
      if (type === 'present') {
        /* 任一侧切换了英雄/皮肤，另一边跟着走 */
        var ph = util.heroById(msg.heroId);
        if (ph) {
          WZ.board.showHero(ph, msg.slotLabel || '预览', msg.side || '', msg.skinIndex || 0);
          if (isDisplay) manualFocus = {
            hero: ph, slotLabel: msg.slotLabel || '预览',
            side: msg.side || '', skinIndex: msg.skinIndex || 0
          };
        }
        return;
      }
      if (type === 'tick') {
        /* 倒计时以控制窗为准 */
        if (isDisplay) {
          timer.total = msg.total || 0;
          timer.left = msg.left || 0;
          timer.running = false;
          renderTimer();
        }
        return;
      }
    });
  }

  /* ------------------------------------------------------------
     状态变化 → 刷新各处
     ------------------------------------------------------------ */
  function onDraftChange(state) {
    if (!isDisplay) {
      syncModeSwitch();
      renderHint(state);
      updateUrl(state);
    }
    WZ.board.render(state);
    /* 战队名不属于 BP 状态，但每次重绘都刷一遍，保证窗口缩放/重载后不丢 */
    pushTeamNames();
    WZ.ui.syncTakenFlags();
    WZ.ui.syncActions();
    /* 赛前面板跟随 BP：撤销/重开时清掉失效英雄，有空位就自动补上。
       放在渲染之后做，它自己会触发一次赛事面板广播。 */
    if (WZ.story && typeof WZ.story.syncFromDraft === 'function') {
      try { WZ.story.syncFromDraft(); } catch (e) { console.error('[story] syncFromDraft failed', e); }
    }
    /* 每次都广播，包括「重开」把进度清成 0 的那次——否则展示窗会停在旧局面 */
    broadcastSnapshot('update');
  }

  function renderHint(state) {
    if (state.done) {
      dom.stepHint.innerHTML = '本局 BP 结束 · 共 <b>' + state.picks.blue.length + '</b> : <b>' +
        state.picks.red.length + '</b> 人选';
      dom.stepHint.classList.remove('pulse');
      return;
    }
    var info = state.stepInfo;
    var who = info.side === 'both' ? '双方'
      : (info.side === 'blue' ? '蓝方' : '红方');
    var verb = info.action === 'ban' ? '禁用' : '选择';
    dom.stepHint.innerHTML = '第 <b>' + (state.step + 1) + '</b>/' + state.totalSteps + ' 步 · ' +
      who + verb + ' · ' + (info.phase || '');
    dom.stepHint.classList.toggle('pulse', true);
  }

  app.onHeroSelected = function (hero) {
    if (!hero) return;
    manualFocus = { hero: hero, slotLabel: '预览', side: '', skinIndex: 0 };
    WZ.board.showHero(hero, '预览 · 未提交', '', 0);
    WZ.ui.syncActions();
    broadcastSnapshot('present');
  };

  app.onSkinSelected = function (hero, skinIndex) {
    if (!hero) return;
    manualFocus = { hero: hero, slotLabel: '预览', side: '', skinIndex: skinIndex };
    WZ.board.showHero(hero, '预览 · 皮肤 ' + (skinIndex + 1), '', skinIndex);
    broadcastSnapshot('present');
  };

  app.onGridChanged = function (shown, total) {
    /* 列表变化时同步一下按钮状态 */
    WZ.ui.syncActions();
  };

  /* ------------------------------------------------------------
     倒计时
     ------------------------------------------------------------ */
  function setTimer(seconds) {
    timer.total = seconds;
    timer.left = seconds * 10;             // 以 0.1s 为单位
    renderTimer();
  }

  function startTimer() {
    if (timer.running) return;
    if (timer.left <= 0) return;
    timer.running = true;
    timer.id = setInterval(function () {
      timer.left -= 1;
      if (timer.left <= 0) { timer.left = 0; stopTimer(); }
      renderTimer();
    }, 100);
    renderTimer();
  }

  function stopTimer() {
    timer.running = false;
    if (timer.id) { clearInterval(timer.id); timer.id = null; }
    renderTimer();
  }

  function toggleTimer() {
    if (timer.running) stopTimer();
    else { if (timer.left <= 0) setTimer(60); startTimer(); }
  }

  function renderTimer() {
    var secs = Math.ceil(timer.left / 10);
    var text = util.pad2(Math.floor(secs / 60)) + ':' + util.pad2(secs % 60);
    var cls = '';
    if (timer.left <= 0) cls = timer.total > 0 ? 'done' : '';
    else if (secs <= 10) cls = 'danger';
    else if (secs <= 20) cls = 'warn';

    if (dom.clock) {
      dom.clock.textContent = text;
      dom.clock.className = 'timer ' + cls;
    }
    if (dom.boardClock) {
      dom.boardClock.textContent = text;
      dom.boardClock.className = 'board-timer ' + (cls || 'idle');
    }
    var btn = document.getElementById('btnTimerStart');
    if (btn) btn.textContent = timer.running ? '暂停' : '开始';
    if (timer.running) broadcastTimer();
  }

  /* 倒计时同步给展示窗（每秒一次，只在真的在跑的时候发） */
  function broadcastTimer() {
    if (isDisplay || suppressBroadcast || !sync) return;
    sync.post({ t: 'tick', total: timer.total, left: timer.left });
  }

  /* ------------------------------------------------------------
     直播模式
     ------------------------------------------------------------ */
  function toggleBoss(force) {
    var on = typeof force === 'boolean' ? force : !document.body.classList.contains('boss');
    document.body.classList.toggle('boss', on);
    var btn = document.getElementById('btnBossMode');
    if (btn) {
      btn.textContent = on ? '退出直播模式' : '直播模式';
      btn.classList.toggle('btn-primary', !on);
    }
    savePref({ boss: on });
    WZ.board.fit();
    setTimeout(function () { WZ.board.fit(); }, 60);
    if (on) toast('直播模式：控制台已隐藏，用 OBS 采集「展示板」区域（Esc 退出）', 'ok', 3600);
  }

  function resizeBoard() { WZ.board.fit(); }

  /* ------------------------------------------------------------
     分享码 / URL
     ------------------------------------------------------------ */
  function openShare() {
    var code = draft.shareCode();
    var url = location.href.split('#')[0] + '#bp=' + code;
    var st = draft.state();
    var summary = st.modeName + ' · ' + st.step + '/' + st.totalSteps + ' 步\n' + url;
    document.getElementById('shareText').value = summary;
    document.getElementById('shareModal').hidden = false;
  }

  function updateUrl(state) {
    try {
      /* 重开之后要把旧的 #bp= 清掉，否则刷新会还原已经清空的局 */
      if (!state || !state.progress) {
        if (/[#&]bp=/.test(location.hash || '')) {
          history.replaceState(null, '', location.pathname + location.search);
        }
        return;
      }
      var code = draft.shareCode();
      if (('#' + 'bp=' + code) !== location.hash) {
        history.replaceState(null, '', '#bp=' + code);
      }
    } catch (e) { /* 忽略 */ }
  }

  function restoreFromUrl(isHashChange) {
    var m = /[#&]bp=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
    if (!m) return false;
    var res = draft.applyShareCode(m[1]);
    if (res.ok) {
      manualFocus = null;
      toast('已从链接还原 BP（' + res.state.step + ' 步）', 'ok');
      return true;
    }
    if (isHashChange) toast('链接中的 BP 数据无法解析', 'err');
    return false;
  }

  /* ------------------------------------------------------------
     本地草稿
     ------------------------------------------------------------ */
  function saveLocalDraft() {
    var st = draft.state();
    /* 用 progress（已执行动作数）判断，而不是 step：
       巅峰赛 ban 阶段整个只占 1 步，用 step 会把已经 ban 掉的 3 个当成没进度 */
    if (!st || !st.progress) { util.store.del(LS_DRAFT); return; }
    try {
      var d = draft.exportData();
      d.savedAt = Date.now();
      util.store.set(LS_DRAFT, JSON.stringify(d));
    } catch (e) { /* 忽略 */ }
  }

  function restoreLocalDraft(silent) {
    var raw = util.store.get(LS_DRAFT);
    if (!raw) return false;
    try {
      var d = JSON.parse(raw);
      var res = draft.importData(d);
      if (!res.ok || !res.applied) return false;
      if (!silent) {
        toast('已恢复上次的 BP 进度（' + res.applied + ' 步）· 点「重开」可清空', 'ok', 4200);
      }
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------
     偏好
     ------------------------------------------------------------ */
  function prefs() {
    try { return JSON.parse(util.store.get(LS_PREFS) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function savePref(patch) {
    var p = prefs();
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    util.store.set(LS_PREFS, JSON.stringify(p));
  }
  function prefMode() {
    var m = prefs().mode;
    return draft.modeById(m) ? m : 'ranked';
  }

  /* 启动后按偏好恢复直播模式 */
  app.applyPrefs = function () {
    if (prefs().boss) toggleBoss(true);
  };

  /* ------------------------------------------------------------
     小提示
     ------------------------------------------------------------ */
  var toastTimer = null;
  function toast(msg, kind, ms) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.className = 'toast show ' + (kind || '');
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.className = 'toast ' + (kind || '');
      setTimeout(function () { dom.toast.hidden = true; }, 220);
    }, ms || 2200);
  }
  app.toast = toast;

  /* ------------------------------------------------------------
     启动引导
     ------------------------------------------------------------ */
  function boot() {
    try {
      app.start();
      app.applyPrefs();
    } catch (err) {
      console.error('[wzbp] boot failed', err);
      var el = document.getElementById('dataStatus');
      if (el) {
        el.textContent = '启动失败：' + (err && err.message ? err.message : err);
        el.style.color = '#ffc7ce';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  WZ.app = app;
})(window.WZ);
