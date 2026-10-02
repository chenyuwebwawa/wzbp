/* ============================================================
   wzbp · 展示板渲染（OBS 采集区域）
   ------------------------------------------------------------
   负责：#board 内的 ban 位 / pick 位 / 中央英雄大图 / 底部状态条
   提供两个入口：
     WZ.board.render(state)               —— 按 BP 状态重绘
     WZ.board.showHero(hero, slotLabel, side, skinIndex) —— 中央大图
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var board = {};

  var dom = {};
  var banSlots = { blue: [], red: [] };
  var pickSlots = { blue: [], red: [] };
  var lastPlaced = null;     // 用于「刚落位」闪动动画
  var currentStage = null;   // { heroId, slotLabel, side, skinIndex }
  var fitted = false;

  /* 设计稿尺寸，与 board.css 保持一致 */
  var DESIGN_W = 1600;
  var DESIGN_H = 900;

  /* 单侧最多几个 ban 位：KPL 5 个（3+2），征召 3 个。
     渲染时按 state.cap 隐藏多余的，避免 KPL 第五个 ban 无处可放。 */
  var MAX_BANS_PER_SIDE = 5;

  /* ------------------------------------------------------------
     构建静态骨架
     ------------------------------------------------------------ */
  board.init = function () {
    dom.board = document.getElementById('board');
    dom.frame = document.getElementById('boardFrame');
    dom.banLaneBlue = document.getElementById('banLaneBlue');
    dom.banLaneRed = document.getElementById('banLaneRed');
    dom.pickLaneBlue = document.getElementById('pickLaneBlue');
    dom.pickLaneRed = document.getElementById('pickLaneRed');
    dom.splash = document.getElementById('stageSplash');
    dom.fallback = document.getElementById('stageFallback');
    dom.stage = document.getElementById('heroStage');
    dom.stageName = document.getElementById('stageName');
    dom.stageTitle = document.getElementById('stageTitle');
    dom.stageSlot = document.getElementById('stageSlot');
    dom.mode = document.getElementById('boardMode');
    dom.phase = document.getElementById('boardPhase');
    dom.phaseDot = document.getElementById('phaseDot');
    dom.status = document.getElementById('boardStatus');

    banSlots = { blue: [], red: [] };
    pickSlots = { blue: [], red: [] };

    buildBanLane(dom.banLaneBlue, 'blue');
    buildBanLane(dom.banLaneRed, 'red');
    buildPickLane(dom.pickLaneBlue, 'blue');
    buildPickLane(dom.pickLaneRed, 'red');

    util.bindImgFallback(dom.splash, '王');

    board.fit();
    window.addEventListener('resize', util.debounce(board.fit, 120));
    return board;
  };

  function buildBanLane(lane, side) {
    lane.innerHTML = '';
    /* 单侧 ban 位上限：KPL 是 5 个（首轮 3 + 次轮 2），征召是 3 个。
       这里按最大值建，多余的由 render 用 display:none 隐藏。 */
    for (var i = 0; i < MAX_BANS_PER_SIDE; i++) {
      var slot = util.el('div', 'ban-slot was-empty');
      var empty = util.el('div', 'bs-empty', 'BAN');
      var cross = util.el('div', 'bs-cross');
      var name = util.el('div', 'bs-name');
      slot.appendChild(empty);
      slot.appendChild(cross);
      slot.appendChild(name);
      slot.style.display = 'none';
      lane.appendChild(slot);
      banSlots[side].push(slot);
    }
  }

  function buildPickLane(lane, side) {
    lane.innerHTML = '';
    for (var i = 0; i < 5; i++) {
      var slot = util.el('div', 'pick-slot empty-' + side);
      var art = util.el('div', 'ps-art');
      var veil = util.el('div', 'ps-veil');
      var body = util.el('div', 'ps-body');
      var name = util.el('div', 'ps-name');
      var sub = util.el('div', 'ps-sub');
      var empty = util.el('div', 'ps-empty', '第 ' + (i + 1) + ' 位');
      body.appendChild(name);
      body.appendChild(sub);
      slot.appendChild(art);
      slot.appendChild(veil);
      slot.appendChild(body);
      slot.appendChild(empty);
      lane.appendChild(slot);
      pickSlots[side].push(slot);
    }
  }

  /* ------------------------------------------------------------
     自适应缩放：让 1600×900 的展示板完整落在窗口里
     ------------------------------------------------------------ */
  board.fit = function () {
    var stage = document.getElementById('stage');
    if (!stage || !dom.frame) return;
    var padX = 16, padY = 18;
    if (document.body.classList.contains('boss')) { padX = 0; padY = 0; }

    /* 用「舞台自己的矩形」而不是 clientHeight 来算可用高度：
       展示窗顶部还有一条 #displayFlag 提示条（约 39px），
       之前只扣了 padding，导致板子底部溢出被 overflow:hidden 切掉。 */
    var rect = stage.getBoundingClientRect();
    var availH = window.innerHeight - rect.top - padY * 2;
    /* 保险：rect 还没布局好时退回 clientHeight */
    if (!availH || availH < 200) availH = Math.max(200, stage.clientHeight - padY * 2);

    /* 宽度同理：减去舞台自身的左右 padding，避免横向被压出滚动条 */
    var availW = Math.max(320, (rect.width || stage.clientWidth) - padX * 2);

    var scale = Math.min(availW / DESIGN_W, availH / DESIGN_H);
    scale = Math.max(0.2, Math.min(scale, 2.5));
    document.documentElement.style.setProperty('--board-scale', String(scale));
    fitted = true;
  };

  /* ------------------------------------------------------------
     渲染 BP 状态
     ------------------------------------------------------------ */

  function heroOf(id) { return util.heroById(id); }

  function fillBanSlot(slot, heroId, justPlaced) {
    var hero = heroOf(heroId);
    slot.style.display = '';
    slot.classList.toggle('was-empty', !hero);
    slot.classList.toggle('filled', !!hero);
    slot.classList.remove('just-placed');
    var img = slot.querySelector('img');
    var nameEl = slot.querySelector('.bs-name');
    if (hero) {
      if (!img) {
        img = document.createElement('img');
        img.alt = hero.name;
        img.decoding = 'async';
        util.bindImgFallback(img, hero.name);
        slot.insertBefore(img, slot.firstChild);
      }
      img.src = util.avatarUrl(hero);
      img.alt = hero.name;
      nameEl.textContent = hero.name;
      if (justPlaced) {
        void slot.offsetWidth;                 // 强制重排以重放动画
        slot.classList.add('just-placed');
      }
    } else {
      if (img) img.remove();
      nameEl.textContent = '';
    }
  }

  function fillPickSlot(slot, heroId, index, side, justPlaced) {
    var hero = heroOf(heroId);
    slot.classList.toggle('filled', !!hero);
    slot.classList.remove('just-placed');
    var art = slot.querySelector('.ps-art');
    var nameEl = slot.querySelector('.ps-name');
    var subEl = slot.querySelector('.ps-sub');
    var emptyEl = slot.querySelector('.ps-empty');

    if (hero) {
      art.style.backgroundImage = 'url("' + util.splashUrl(hero, 0) + '")';
      nameEl.textContent = hero.name;
      subEl.innerHTML = '';
      var bits = [];
      (hero.roles || []).forEach(function (r) { bits.push(r); });
      (hero.types || []).forEach(function (t) { bits.push(t); });
      if (bits.length) {
        bits.forEach(function (b, i) {
          if (i) subEl.appendChild(util.el('span', 'sep', '·'));
          subEl.appendChild(document.createTextNode(b));
        });
      } else if (hero.title) {
        subEl.textContent = hero.title;
      }
      if (justPlaced) {
        void slot.offsetWidth;
        slot.classList.add('just-placed');
      }
    } else {
      art.style.backgroundImage = '';
      nameEl.textContent = '';
      subEl.textContent = '';
      emptyEl.textContent = (side === 'blue' ? '蓝方' : '红方') + '第 ' + (index + 1) + ' 位';
    }
  }

  board.render = function (state) {
    if (!dom.board || !state) return;
    /* 标题与阶段 */
    dom.mode.textContent = state.modeName;
    var info = state.stepInfo;
    var phaseText = '等待开始';
    var dotClass = '';
    if (state.done) {
      phaseText = '本局 BP 结束';
      dotClass = 'gold';
    } else if (info) {
      var who = info.side === 'both' ? '双方' : (info.side === 'blue' ? '蓝方' : '红方');
      phaseText = info.phase + ' · ' + who + (info.action === 'ban' ? '禁用' : '选择');
      if (info.tip) phaseText += ' · ' + info.tip;
      dotClass = info.side === 'both' ? 'gold' : info.side;
    }
    dom.phase.textContent = phaseText;
    dom.phaseDot.className = 'phase-dot ' + dotClass;
    dom.board.classList.toggle('is-done', !!state.done);

    /* ban 位 */
    var cap = state.cap || { blue: { ban: 3 }, red: { ban: 3 } };
    var stepDone = state.stepDone || [];
    ['blue', 'red'].forEach(function (side) {
      var shown = Math.max(cap[side].ban, 3);
      /* 双方同步的步骤里，已经出过手的一侧不再高亮 */
      var sideWaiting = !!(info && !state.done &&
        (info.side === 'both' || info.side === side) && stepDone.indexOf(side) === -1);
      for (var i = 0; i < banSlots[side].length; i++) {
        var slot = banSlots[side][i];
        if (i >= shown) { slot.style.display = 'none'; continue; }
        var id = state.bans[side][i];
        var justPlaced = !!(id !== undefined && lastPlaced &&
          lastPlaced.kind === 'ban' && lastPlaced.side === side && lastPlaced.index === i);
        fillBanSlot(slot, id, justPlaced);
        slot.classList.toggle('active', !!(sideWaiting && info.action === 'ban' &&
          i === state.bans[side].length));
      }

      /* pick 位 */
      for (var j = 0; j < 5; j++) {
        var pslot = pickSlots[side][j];
        var pid = state.picks[side][j];
        var pJust = !!(pid !== undefined && lastPlaced &&
          lastPlaced.kind === 'pick' && lastPlaced.side === side && lastPlaced.index === j);
        fillPickSlot(pslot, pid, j, side, pJust);
        pslot.classList.toggle('active', !!(info && info.action === 'pick' && !state.done &&
          (info.side === 'both' || info.side === side) && stepDone.indexOf(side) === -1 &&
          j === state.picks[side].length));
      }
    });

    /* 中央大图：优先显示刚发生的一手；没有则显示上一次展示的英雄 */
    var focus = findFocus(state);
    if (focus) {
      board.showHero(focus.hero, focus.slotLabel, focus.side, focus.skinIndex);
    }

    /* 底部状态条 */
    renderStatus(state);
  };

  /* 找到「该展示在中央」的英雄：最后一步 ban / pick */
  function findFocus(state) {
    if (!state) return null;
    var steps = WZ.draft.rules(state.mode).steps;
    var doneSteps = Math.min(state.step, steps.length);
    for (var i = doneSteps - 1; i >= 0; i--) {
      var sp = steps[i];
      /* 每一步的实际归属：普通步骤取 steps 定义，双方同时的步骤取 stepSides */
      var side = sp.s === 'both' ? (state.stepSides && state.stepSides[i]) || 'blue' : sp.s;
      var arr = sp.a === 'ban' ? state.bans[side] : state.picks[side];
      /* 该侧在这一步之前的同名动作数 = 该步在本侧序号 */
      var n = 0;
      for (var k = 0; k <= i; k++) {
        var s2 = steps[k];
        var sideK = s2.s === 'both' ? (state.stepSides && state.stepSides[k]) || 'blue' : s2.s;
        if (s2.a === sp.a && sideK === side) n++;
      }
      var id = arr[n - 1];
      if (id === undefined || id === null) continue;
      var hero = util.heroById(id);
      if (!hero) continue;
      var label = sp.a === 'ban'
        ? (side === 'blue' ? '蓝方禁用' : '红方禁用')
        : (side === 'blue' ? '蓝方 ' : '红方 ') + ord(n);
      return { hero: hero, slotLabel: label, side: side, skinIndex: 0 };
    }
    return null;
  }

  function ord(n) {
    var map = ['一', '二', '三', '四', '五'];
    return (map[n - 1] || n) + '楼';
  }

  /* 中央英雄大图 */
  var showToken = 0;                 // 防止旧图片的回调盖掉新选择
  board.showHero = function (hero, slotLabel, side, skinIndex) {
    if (!hero || !dom.splash) return;
    var my = ++showToken;
    dom.splash.classList.remove('show');
    dom.stage.classList.remove('no-art');

    var url = util.splashUrl(hero, skinIndex || 0);
    var wanted = String(hero.id) + '#' + (skinIndex || 0);

    var apply = function () {
      /* 期间又切了别的英雄/皮肤 —— 这次结果作废 */
      if (my !== showToken) return;
      if (currentStage && currentStage.key === wanted && dom.splash.classList.contains('show')) return;
      currentStage = { key: wanted, heroId: hero.id, slotLabel: slotLabel, side: side, skinIndex: skinIndex || 0 };
      dom.splash.src = url;
      dom.splash.alt = hero.name;
      /* 图片加载完成再淡入，避免闪白 */
      var reveal = function () {
        if (my !== showToken) return;
        dom.splash.classList.add('show');
        dom.stage.classList.remove('no-art');
      };
      if (dom.splash.complete && dom.splash.naturalWidth) reveal();
      else {
        dom.splash.onload = reveal;
        dom.splash.onerror = function () {
          if (my !== showToken) return;
          dom.stage.classList.add('no-art');
          dom.splash.classList.remove('show');
        };
      }
      dom.stageName.textContent = hero.name;
      dom.stageTitle.textContent = hero.title || '';
      dom.stageSlot.textContent = slotLabel || '';
      dom.stageSlot.className = 'badge-slot ' + (side || '');
    };

    /* 预加载后切换，避免大图切换时黑屏 */
    var pre = new Image();
    pre.onload = apply;
    pre.onerror = apply;
    pre.src = url;
  };

  board.currentStage = function () { return currentStage; };

  function renderStatus(state) {
    var blueBan = state.bans.blue.length, redBan = state.bans.red.length;
    var bluePick = state.picks.blue.length, redPick = state.picks.red.length;
    var total = state.totalSteps;
    var left = util.el('div', 'st-left');
    var stepText = state.done
      ? '全部 ' + total + ' 步已完成'
      : '第 ' + (state.step + 1) + ' / ' + total + ' 步';
    left.appendChild(util.el('span', 'st-step', stepText));
    if (state.stepInfo && !state.done) {
      left.appendChild(util.el('span', 'st-tag ' + (state.stepInfo.side === 'red' ? 'red' : 'blue'),
        state.stepInfo.side === 'both' ? '双方禁用进行中'
          : (state.stepInfo.side === 'blue' ? '蓝方回合' : '红方回合')));
    }
    if (state.pool && state.pool.length) {
      left.appendChild(util.el('span', '', '剩余可选 ' + state.pool.length + ' 位'));
    }

    var right = util.el('div', 'st-right');
    right.appendChild(util.el('span', 'st-tag blue', '蓝 · ban ' + blueBan + ' / pick ' + bluePick));
    right.appendChild(util.el('span', 'st-tag red', '红 · ban ' + redBan + ' / pick ' + redPick));
    var src = (WZ.HERO_META && WZ.HERO_META.generatedAt) ? ('英雄数据 ' + WZ.HERO_META.generatedAt) : '';
    if (src) right.appendChild(util.el('span', '', src));

    dom.status.innerHTML = '';
    dom.status.appendChild(left);
    dom.status.appendChild(right);
  }

  /* 标记「刚落位」的目标，供下一次 render 播放动画 */
  board.markPlaced = function (kind, side, index) {
    lastPlaced = { kind: kind, side: side, index: index };
  };
  board.clearPlaced = function () { lastPlaced = null; };

  WZ.board = board;
})(window.WZ);
