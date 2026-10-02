/* ============================================================
   wzbp · 控制台 UI
   ------------------------------------------------------------
   左侧：搜索 + 分路筛选 + 英雄网格
   右侧：英雄原画/皮肤切换 + 技能 + ban/pick 操作按钮
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var ui = {};

  /* 分路展示顺序（以数据里实际出现的为准，这里只定义优先级） */
  var ROLE_ORDER = ['对抗路', '打野', '中路', '发育路', '游走', '辅助', '上路', '下路'];
  var TYPE_ORDER = ['坦克', '战士', '刺客', '法师', '射手', '辅助'];

  var dom = {};
  var allHeroes = [];
  var roleCounts = {};      // role/type -> 拥有该标签的英雄数
  var filterKeys = [];      // 实际渲染出来的筛选项（含 'all'）
  var selectedId = null;
  var selectedSkin = 0;
  var query = '';
  var activeRole = 'all';
  var filtered = [];

  /* ------------------------------------------------------------
     初始化
     ------------------------------------------------------------ */
  ui.init = function () {
    dom.search = document.getElementById('searchInput');
    dom.searchClear = document.getElementById('searchClear');
    dom.roleFilter = document.getElementById('roleFilter');
    dom.grid = document.getElementById('heroGrid');
    dom.empty = document.getElementById('gridEmpty');
    dom.panel = document.getElementById('sidePanel');

    allHeroes = (WZ.HEROES || []).slice();
    allHeroes.sort(function (a, b) { return (a.id || 0) - (b.id || 0); });

    roleCounts = computeCounts(allHeroes);
    buildRoleFilter();

    dom.search.addEventListener('input', util.debounce(function () {
      query = dom.search.value;
      refresh();
    }, 90));
    dom.search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { dom.search.value = ''; query = ''; refresh(); }
      if (e.key === 'Enter') {
        /* 回车选中第一个结果 */
        if (filtered.length) select(filtered[0].id, true);
      }
    });
    dom.searchClear.addEventListener('click', function () {
      dom.search.value = '';
      query = '';
      dom.search.focus();
      refresh();
    });

    dom.grid.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.hero-card') : null;
      if (!card) return;
      /* 赛事面板处于「点左侧列表选英雄」模式时，这次点击是给面板选英雄 */
      var hero = util.heroById(Number(card.dataset.id));
      if (hero && WZ.storyPanel && WZ.storyPanel.isPicking && WZ.storyPanel.isPicking()) {
        WZ.storyPanel.acceptPick(hero);
        return;
      }
      select(Number(card.dataset.id), true);
    });

    dom.panel.addEventListener('click', onPanelClick);

    refresh();
    return ui;
  };

  function computeCounts(list) {
    var counts = {};
    list.forEach(function (h) {
      var tags = (h.roles || []).concat(h.types || []);
      var seen = {};
      tags.forEach(function (t) {
        if (seen[t]) return;
        seen[t] = 1;
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return counts;
  }

  function buildRoleFilter() {
    var keys = Object.keys(roleCounts);
    keys.sort(function (a, b) {
      var ia = ROLE_ORDER.indexOf(a), ib = ROLE_ORDER.indexOf(b);
      if (ia < 0) ia = 100 + TYPE_ORDER.indexOf(a);
      if (ib < 0) ib = 100 + TYPE_ORDER.indexOf(b);
      if (ia < 0) ia = 900;
      if (ib < 0) ib = 900;
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b);
    });
    filterKeys = ['all'].concat(keys);

    dom.roleFilter.innerHTML = '';
    filterKeys.forEach(function (key) {
      var btn = util.el('button', key === 'all' ? 'on' : '');
      btn.type = 'button';
      btn.dataset.role = key;
      btn.appendChild(document.createTextNode(key === 'all' ? '全部' : key));
      var cnt = util.el('span', 'cnt', key === 'all' ? String(allHeroes.length) : String(roleCounts[key] || 0));
      btn.appendChild(cnt);
      dom.roleFilter.appendChild(btn);
    });

    dom.roleFilter.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      activeRole = btn.dataset.role;
      util.$$('button', dom.roleFilter).forEach(function (b) {
        b.classList.toggle('on', b.dataset.role === activeRole);
      });
      refresh();
    });
  }

  /* ------------------------------------------------------------
     刷新列表
     ------------------------------------------------------------ */
  function refresh() {
    filtered = util.searchHeroes(query, { role: activeRole });
    renderGrid();
    renderPanelState();
    if (WZ.app && WZ.app.onGridChanged) WZ.app.onGridChanged(filtered.length, allHeroes.length);
  }

  function takenInfo(id) {
    var st = WZ.draft.state();
    var sides = ['blue', 'red'], i, j;
    for (i = 0; i < sides.length; i++) {
      for (j = 0; j < st.bans[sides[i]].length; j++) {
        if (String(st.bans[sides[i]][j]) === String(id)) {
          return { kind: 'ban', side: sides[i], index: j };
        }
      }
      for (j = 0; j < st.picks[sides[i]].length; j++) {
        if (String(st.picks[sides[i]][j]) === String(id)) {
          return { kind: 'pick', side: sides[i], index: j };
        }
      }
    }
    return null;
  }

  function renderGrid() {
    if (!filtered.length) {
      dom.grid.innerHTML = '';
      dom.grid.hidden = true;
      dom.empty.hidden = false;
      dom.empty.textContent = query
        ? '没有找到「' + query + '」' + (activeRole !== 'all' ? '（分路：' + activeRole + '）' : '')
        : '该分路下暂无英雄';
      return;
    }
    dom.grid.hidden = false;
    dom.empty.hidden = true;

    var frag = document.createDocumentFragment();
    filtered.forEach(function (hero) {
      var card = util.el('div', 'hero-card');
      card.dataset.id = hero.id;
      card.tabIndex = 0;
      card.title = hero.name + (hero.title ? ' · ' + hero.title : '') +
        ((hero.roles || []).length ? ' · ' + hero.roles.join('/') : '');
      if (hero.id === selectedId) card.classList.add('selected');

      var img = document.createElement('img');
      img.className = 'hc-img';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = hero.name;
      img.src = util.avatarUrl(hero);
      util.bindImgFallback(img, hero.name);
      card.appendChild(img);

      var name = util.el('div', 'hc-name', hero.name);
      card.appendChild(name);

      var taken = takenInfo(hero.id);
      if (taken) {
        card.classList.add('is-taken', taken.kind === 'ban' ? 'is-ban' : 'is-pick');
        var flag = util.el('div', 'hc-flag ' + taken.side);
        flag.appendChild(util.el('span', 'tag', taken.kind === 'ban' ? 'BAN' : 'PICK'));
        card.appendChild(flag);
      }

      frag.appendChild(card);
    });

    dom.grid.innerHTML = '';
    dom.grid.appendChild(frag);
  }

  /* ------------------------------------------------------------
     选中英雄 → 右侧详情
     ------------------------------------------------------------ */
  function select(id, notifyApp) {
    selectedId = id;
    selectedSkin = 0;
    var hero = util.heroById(id);
    if (hero) util.preload(util.splashUrl(hero, 0));
    util.$$('.hero-card', dom.grid).forEach(function (c) {
      c.classList.toggle('selected', Number(c.dataset.id) === id);
    });
    renderPanel();
    if (notifyApp !== false && WZ.app && WZ.app.onHeroSelected) WZ.app.onHeroSelected(hero);
  }

  ui.selectHero = function (id) { select(id, false); };
  ui.selectedHero = function () { return selectedId ? util.heroById(selectedId) : null; };
  ui.selectedSkin = function () { return selectedSkin; };
  ui.currentFilter = function () {
    return { query: query, role: activeRole, count: filtered.length };
  };

  /* 赛事面板的「选英雄」模式提示 */
  ui.hintPick = function (on) {
    document.body.classList.toggle('picking-hero', !!on);
    if (!on && WZ.storyPanel && WZ.storyPanel.cancelPick) { /* 由面板自己清理 */ }
    return true;
  };

  /* 只更新「已 ban / 已 pick」标记，不重建整个网格（保持滚动位置） */
  ui.syncTakenFlags = function () {
    if (dom.grid.hidden) return;
    util.$$('.hero-card', dom.grid).forEach(function (card) {
      var id = Number(card.dataset.id);
      var taken = takenInfo(id);
      var old = card.querySelector('.hc-flag');
      if (old) old.remove();
      card.classList.remove('is-taken', 'is-ban', 'is-pick');
      if (taken) {
        card.classList.add('is-taken', taken.kind === 'ban' ? 'is-ban' : 'is-pick');
        var flag = util.el('div', 'hc-flag ' + taken.side);
        flag.appendChild(util.el('span', 'tag', taken.kind === 'ban' ? 'BAN' : 'PICK'));
        card.appendChild(flag);
      }
      card.classList.toggle('selected', id === selectedId);
    });
  };

  function renderPanelState() {
    if (!selectedId || !util.heroById(selectedId)) {
      dom.panel.innerHTML = '<div class="sel-empty">点击左侧英雄查看原画与技能</div>';
    }
  }

  function skillBlock(hero) {
    var sk = (typeof WZ.skillsById === 'function' ? WZ.skillsById(hero.id) : null) ||
      (WZ.SKILLS ? WZ.SKILLS[String(hero.id)] : null);
    var wrap = util.el('div', 'pv-skills');
    if (!sk) {
      wrap.appendChild(util.el('h4', '', '技能'));
      var none = util.el('div', 'sk-desc', '暂无该英雄的技能数据（详情页未解析到）。');
      wrap.appendChild(none);
      return wrap;
    }
    if (sk.passive && (sk.passive.name || sk.passive.desc)) {
      wrap.appendChild(util.el('h4', '', '被动'));
      wrap.appendChild(skillItem('被动', sk.passive.name, sk.passive.desc, ''));
    }
    if (sk.skills && sk.skills.length) {
      wrap.appendChild(util.el('h4', '', '技能'));
      sk.skills.forEach(function (s) {
        wrap.appendChild(skillItem(s.key || '', s.name, s.desc, s.cooldown));
      });
    }
    return wrap;
  }

  function skillItem(key, name, desc, cd) {
    var item = util.el('div', 'skill-item');
    item.appendChild(util.el('div', 'sk-key', key || '·'));
    var body = util.el('div');
    var h = util.el('div', 'sk-name');
    h.appendChild(document.createTextNode(name || ''));
    if (cd) h.appendChild(util.el('span', 'sk-cd', 'CD ' + cd));
    body.appendChild(h);
    if (desc) body.appendChild(util.el('div', 'sk-desc', desc));
    item.appendChild(body);
    return item;
  }

  function renderPanel() {
    var hero = util.heroById(selectedId);
    if (!hero) {
      renderPanelState();
      return;
    }

    dom.panel.innerHTML = '';

    /* 原画 */
    var art = util.el('div', 'preview-art');
    var img = document.createElement('img');
    img.alt = hero.name;
    img.decoding = 'async';
    img.src = util.splashUrl(hero, selectedSkin);
    util.bindImgFallback(img, hero.name);
    art.appendChild(img);
    art.appendChild(util.el('div', 'pv-grad'));
    art.appendChild(util.el('div', 'pv-name', hero.name));
    art.appendChild(util.el('div', 'pv-title', hero.title || ''));
    dom.panel.appendChild(art);

    /* 皮肤条 */
    var skins = hero.skins || [];
    var splashes = util.splashes(hero);
    if (splashes.length > 1) {
      var strip = util.el('div', 'skin-strip');
      splashes.forEach(function (url, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = i === selectedSkin ? 'on' : '';
        b.title = skins[i] || ('皮肤 ' + (i + 1));
        b.dataset.skin = String(i);
        var thumb = document.createElement('img');
        thumb.src = url;
        thumb.alt = skins[i] || '';
        thumb.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
        b.appendChild(thumb);
        var nm = util.el('span', 'skin-name', skins[i] || ('皮肤 ' + (i + 1)));
        b.appendChild(nm);
        strip.appendChild(b);
      });
      dom.panel.appendChild(strip);
    }

    /* 标签 */
    var meta = util.el('div', 'pv-meta');
    (hero.roles || []).forEach(function (r) { meta.appendChild(util.el('span', 'chip role', r)); });
    (hero.types || []).forEach(function (t) { meta.appendChild(util.el('span', 'chip type', t)); });
    var p = hero.pinyin || {};
    if (p.idName || p.full) meta.appendChild(util.el('span', 'chip pinyin', p.idName || p.full));
    if (p.initials) meta.appendChild(util.el('span', 'chip pinyin', p.initials.toUpperCase()));
    dom.panel.appendChild(meta);

    /* 技能 */
    dom.panel.appendChild(skillBlock(hero));

    /* 操作按钮 */
    dom.panel.appendChild(buildActions(hero));
    syncActions();
  }

  function buildActions(hero) {
    var box = util.el('div', 'pv-actions');
    var btns = [
      { id: 'actPickBlue', side: 'blue', action: 'pick', cls: 'act-blue', label: '蓝方选择' },
      { id: 'actPickRed', side: 'red', action: 'pick', cls: 'act-red', label: '红方选择' },
      { id: 'actBanBlue', side: 'blue', action: 'ban', cls: 'act-blue', label: '蓝方禁用' },
      { id: 'actBanRed', side: 'red', action: 'ban', cls: 'act-red', label: '红方禁用' }
    ];
    btns.forEach(function (b) {
      var btn = util.el('button', 'btn ' + b.cls, b.label);
      btn.type = 'button';
      btn.id = b.id;
      btn.dataset.side = b.side;
      btn.dataset.action = b.action;
      box.appendChild(btn);
    });
    /* 空 ban：禁用阶段可以不下手。按钮在步骤提示条上（常驻可见），
       不需要先选英雄 —— 所以它不放在「选中英雄后才有」的侧栏里。 */
    var empty = util.el('button', 'btn btn-ghost act-empty-ban', '空 BAN（跳过这次禁用）');
    empty.type = 'button';
    empty.id = 'actEmptyBanPanel';
    empty.dataset.emptyBan = '1';
    box.appendChild(empty);
    var hint = util.el('button', 'btn btn-ghost wide', '取消选中');
    hint.type = 'button';
    hint.id = 'actCancel';
    box.appendChild(hint);
    return box;
  }

  function onPanelClick(e) {
    var target = e.target.closest ? e.target.closest('button') : null;
    if (!target) return;
    if (target.dataset.skin !== undefined) {
      selectedSkin = Number(target.dataset.skin);
      util.$$('button', dom.panel.querySelector('.skin-strip') || dom.panel).forEach(function (b) {
        if (b.dataset.skin !== undefined) b.classList.toggle('on', Number(b.dataset.skin) === selectedSkin);
      });
      var img = dom.panel.querySelector('.preview-art img');
      var hero = util.heroById(selectedId);
      if (img && hero) {
        img.src = util.splashUrl(hero, selectedSkin);
      }
      if (WZ.app && WZ.app.onSkinSelected) WZ.app.onSkinSelected(hero, selectedSkin);
      return;
    }
    if (target.id === 'actCancel') {
      selectedId = null;
      renderPanel();
      util.$$('.hero-card', dom.grid).forEach(function (c) { c.classList.remove('selected'); });
      return;
    }
    if (target.dataset.emptyBan) {
      /* 空 ban 不需要先选英雄，所以要在「必须有 hero」的判断之前处理 */
      var side = emptyBanSide();
      if (side && WZ.app && WZ.app.onEmptyBan) WZ.app.onEmptyBan(side);
      return;
    }
    if (target.dataset.action) {
      var hero = util.heroById(selectedId);
      if (!hero) return;
      if (WZ.app && WZ.app.onAction) {
        WZ.app.onAction(target.dataset.side, target.dataset.action, hero);
      }
    }
  }

  /* ------------------------------------------------------------
     v3：BP 锁
     ------------------------------------------------------------
     联网房间里，管理员点「开始 BP」之前任何人都不能落子（服务端也会拒）。
     这里在客户端先锁住，避免用户点了半天没反应、以为坏了。 */
  var lock = { on: false, reason: '' };

  ui.setLocked = function (on, reason) {
    var v = !!on;
    var r = String(reason || '');
    if (lock.on === v && lock.reason === r) return;
    lock.on = v;
    lock.reason = r;
    applyLock();
  };
  ui.isLocked = function () { return lock.on; };

  function applyLock() {
    var grid = document.getElementById('heroGrid');
    if (grid) grid.classList.toggle('wz-bp-locked', lock.on);
    var old = document.getElementById('wzBpLockNote');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!lock.on) return;
    /* 在英雄网格上方贴一条提示，说清楚为什么不能点 */
    var host = grid && grid.parentNode;
    if (!host) return;
    var note = document.createElement('div');
    note.id = 'wzBpLockNote';
    note.textContent = '⏳ ' + (lock.reason || '等待管理员开始 BP');
    host.insertBefore(note, grid);
  }

  /* 当前该由哪一方禁用 —— 空 ban 按钮要知道替谁空 ban。
     巅峰赛的 both 步里按蓝方优先（实际双方都能空，先到先得）。 */
  function emptyBanSide() {
    var st = WZ.draft.state();
    if (!st || !st.stepInfo || st.stepInfo.action !== 'ban') return null;
    if (st.stepInfo.side === 'both') return 'blue';
    return st.stepInfo.side;
  }
  ui.emptyBanSide = emptyBanSide;

  /* 根据当前 BP 步骤刷新按钮可用状态 */
  function syncActions() {
    if (!dom.panel) return;

    /* 空 BAN 按钮：禁用阶段且轮得到时才可用。
       步骤提示条上那个（#actEmptyBan）是常驻的；侧栏里那个（#actEmptyBanPanel）
       只在选中英雄后才存在，两个都要同步。 */
    var emptyBtns = [document.getElementById('actEmptyBan'),
      document.getElementById('actEmptyBanPanel')];
    var canEmpty = !lock.on && !!WZ.draft.canEmptyBan(emptyBanSide());
    emptyBtns.forEach(function (b) {
      if (!b) return;
      b.disabled = !canEmpty;
      b.title = canEmpty
        ? '本步不下 ban（空 ban），直接轮到下一位'
        : (lock.on ? (lock.reason || '等待管理员开始 BP') : '现在是选择阶段 / 没轮到禁用，不能空 ban');
    });

    var btns = util.$$('.pv-actions button[data-action]', dom.panel);
    if (!btns.length) return;
    var hero = util.heroById(selectedId);
    var taken = hero ? takenInfo(hero.id) : null;
    var st = WZ.draft.state();
    var globalOn = !!(st && st.global);
    var globalUsed = (st && st.globalUsed) || { blue: [], red: [] };

    btns.forEach(function (b) {
      var can = !!hero && !taken && WZ.draft.canAct(b.dataset.side, b.dataset.action);
      /* v3：管理员还没点「开始 BP」时，所有操作都锁住 */
      if (lock.on) can = false;
      /* 全局 BP：本方之前小局选过的英雄，本方不能再选；禁用不受限制 */
      var blocked = false;
      if (can && globalOn && b.dataset.action === 'pick' && hero) {
        var list = globalUsed[b.dataset.side] || [];
        for (var i = 0; i < list.length; i++) {
          if (String(list[i]) === String(hero.id)) { blocked = true; break; }
        }
      }
      b.disabled = !can || blocked;
      b.classList.toggle('hot', can && !blocked);
      b.title = blocked
        ? ((b.dataset.side === 'blue' ? '蓝方' : '红方') + '在之前的小局已选用该英雄（全局 BP）')
        : '';
      if (taken && taken.side === b.dataset.side && taken.kind === b.dataset.action) {
        b.textContent = taken.kind === 'ban' ? '已禁用' : '已选择';
      } else if (blocked) {
        b.textContent = (b.dataset.side === 'blue' ? '蓝方' : '红方') + '已用过';
      } else {
        b.textContent = (b.dataset.side === 'blue' ? '蓝方' : '红方') +
          (b.dataset.action === 'ban' ? '禁用' : '选择');
      }
    });
  }

  /* 步骤/状态变化时由外面调用 */
  ui.syncActions = syncActions;

  ui.refresh = function () { refresh(); };

  WZ.ui = ui;
})(window.WZ);
