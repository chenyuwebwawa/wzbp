/* ============================================================
   wzbp · 赛事面板控制台（表单 + 开采集窗）
   ------------------------------------------------------------
   在控制窗里编辑 MVP 卡与赛前面板的数据，并打开独立采集页。
   注意：注册点只有一处（app.start() 里调一次），避免重蹈按键双绑定的坑。
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var story = WZ.story;
  var panel = {};

  var dom = {};
  var tab = 'mvp';
  var heroPickTarget = null;        // { kind:'mvp' } 或 { kind:'player', side, index }
  var bound = false;
  var overlayWin = {};              // 采集窗句柄，按 mode 记

  /* ---------------- 打开 / 关闭抽屉 ---------------- */

  panel.init = function () {
    dom.drawer = document.getElementById('storyDrawer');
    dom.body = document.getElementById('sdBody');
    dom.tabs = document.getElementById('sdTabs');
    dom.title = document.getElementById('sdTitle');
    if (!dom.drawer) return panel;

    if (!bound) {
      bound = true;

      /* 顶栏按钮 */
      var btn = document.getElementById('btnStoryPanel');
      if (btn) btn.addEventListener('click', function () { panel.toggle(); });

      document.getElementById('sdClose').addEventListener('click', function () { panel.close(); });

      dom.tabs.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button') : null;
        if (!b) return;
        panel.setTab(b.dataset.tab);
      });

      /* 抽屉内的输入：统一走事件委托，避免每次重绘都重绑 */
      dom.body.addEventListener('input', onFieldInput);
      dom.body.addEventListener('change', onFieldInput);
      dom.body.addEventListener('click', onBodyClick);

      /* 数据变化就重绘表单（但要避开正在输入的那个框，否则光标会跳） */
      story.on(function () { panel.refresh(); });
      if (WZ.draft) {
        WZ.draft.on(function () { if (tab === 'pre' && panel.isOpen()) panel.refresh(); });
      }
    }

    panel.setTab('mvp');
    return panel;
  };

  panel.isOpen = function () {
    return !!(dom.drawer && dom.drawer.classList.contains('open'));
  };

  panel.open = function () {
    if (!dom.drawer) return;
    dom.drawer.hidden = false;
    /* 强制一次重排，让 transform 过渡生效 */
    void dom.drawer.offsetWidth;
    dom.drawer.classList.add('open');
    panel.refresh();
  };

  panel.close = function () {
    if (!dom.drawer) return;
    dom.drawer.classList.remove('open');
    setTimeout(function () {
      if (!dom.drawer.classList.contains('open')) dom.drawer.hidden = true;
    }, 240);
  };

  panel.toggle = function () {
    panel.isOpen() ? panel.close() : panel.open();
  };

  panel.setTab = function (t) {
    tab = (t === 'pre' || t === 'record') ? t : 'mvp';
    util.$$('button', dom.tabs).forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    if (dom.title) {
      dom.title.textContent = tab === 'mvp' ? 'MVP 数据面板'
        : (tab === 'record' ? '战绩面板' : '赛前面板');
    }
    panel.refresh();
  };

  /* ---------------- 表单渲染 ---------------- */

  panel.refresh = function () {
    if (!dom.body || !panel.isOpen()) return;
    /* 正在输入时不要整块重建，否则输入法/光标会断 */
    var ae = document.activeElement;
    if (ae && dom.body.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      syncHeroPickers();
      return;
    }
    dom.body.innerHTML = '';
    var d = story.get();
    dom.body.appendChild(tab === 'mvp' ? buildMvpForm(d)
      : (tab === 'record' ? buildRecordForm(d) : buildPreForm(d)));
  };

  function field(label, value, path, opts) {
    opts = opts || {};
    var wrap = util.el('div', opts.wide ? '' : 'field');
    var lb = util.el('label', '', label);
    wrap.appendChild(lb);
    var input;
    if (opts.textarea) {
      input = document.createElement('textarea');
      input.rows = opts.rows || 2;
    } else {
      input = document.createElement('input');
      input.type = opts.type || 'text';
      if (opts.placeholder) input.placeholder = opts.placeholder;
    }
    input.value = value === undefined || value === null ? '' : value;
    input.dataset.path = path;
    wrap.appendChild(input);
    return wrap;
  }

  /* ---------- MVP 表单 ---------- */

  function buildMvpForm(d) {
    var frag = document.createDocumentFragment();
    var m = d.mvp;

    var sec1 = util.el('div', 'sd-section');
    sec1.appendChild(util.el('h4', '', '赛事信息'));
    var r1 = util.el('div', 'field-row');
    r1.appendChild(field('赛事名', d.event, 'event', { placeholder: '2026 KPL 春季赛' }));
    r1.appendChild(field('阶段', d.stage, 'stage', { placeholder: '常规赛 第3周' }));
    sec1.appendChild(r1);
    sec1.appendChild(field('一句话点评', m.song, 'mvp.song',
      { textarea: true, rows: 2, placeholder: '这一手算无遗策，全场节奏尽在掌握' }));
    frag.appendChild(sec1);

    var sec2 = util.el('div', 'sd-section');
    sec2.appendChild(util.el('h4', '', '选手'));
    var r2 = util.el('div', 'field-row');
    r2.appendChild(field('选手 ID', m.playerId, 'mvp.playerId', { placeholder: '一诺' }));
    r2.appendChild(field('真实姓名（可选）', m.realName, 'mvp.realName', { placeholder: '徐必成' }));
    sec2.appendChild(r2);
    var r3 = util.el('div', 'field-row');
    r3.appendChild(field('战队', m.team, 'mvp.team', { placeholder: '成都AG超玩会' }));
    r3.appendChild(field('位置', m.position, 'mvp.position', { placeholder: '发育路' }));
    sec2.appendChild(r3);
    sec2.appendChild(field('第几局', m.gameNo, 'mvp.gameNo', { placeholder: '第一局' }));
    frag.appendChild(sec2);

    /* 英雄 */
    var sec3 = util.el('div', 'sd-section');
    sec3.appendChild(util.el('h4', '', '英雄'));
    sec3.appendChild(heroPicker('mvp'));
    var hint = util.el('p', 'sd-hint', '点「选择英雄」后，到左侧英雄列表里点一下即可（会取该英雄的官网原画）。');
    sec3.appendChild(hint);
    frag.appendChild(sec3);

    /* 战绩 */
    var sec4 = util.el('div', 'sd-section');
    sec4.appendChild(util.el('h4', '', '战绩数据'));
    var stats = m.stats || [];
    stats.forEach(function (s, i) {
      sec4.appendChild(statRow(s, i));
    });
    var presets = util.el('div', 'preset-row');
    story.STAT_PRESETS.forEach(function (p) {
      var b = util.el('button', '', '+ ' + p);
      b.type = 'button';
      b.dataset.addStat = p;
      presets.appendChild(b);
    });
    sec4.appendChild(presets);
    frag.appendChild(sec4);

    /* 显示开关 */
    var sec5 = util.el('div', 'sd-section');
    sec5.appendChild(buildVisibilityRow('mvp'));
    frag.appendChild(sec5);

    return frag;
  }

  function statRow(s, i) {
    var row = util.el('div', 'stat-row');
    var label = document.createElement('input');
    label.type = 'text';
    label.placeholder = '数据名（如 输出占比）';
    label.value = s.label || '';
    label.dataset.statLabel = String(i);
    var value = document.createElement('input');
    value.type = 'text';
    value.placeholder = '数值';
    value.value = s.value || '';
    value.dataset.statValue = String(i);
    var del = util.el('button', 'del', '×');
    del.type = 'button';
    del.title = '删除这项';
    del.dataset.delStat = String(i);
    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(del);
    return row;
  }

  function heroPicker(kind, side, index) {
    var d = story.get();
    var heroId = null, skinIndex = 0, sub = '';
    if (kind === 'mvp') {
      heroId = d.mvp.heroId;
      skinIndex = d.mvp.skinIndex || 0;
      sub = 'MVP 卡中央大图';
    } else {
      var p = d.pre[side].players[index];
      heroId = p.heroId;
      skinIndex = p.skinIndex || 0;
      sub = (side === 'blue' ? '蓝方' : '红方') + ' 第 ' + (index + 1) + ' 位';
    }
    var hero = heroId ? util.heroById(heroId) : null;

    var box = util.el('div', 'hero-pick');
    box.dataset.picker = '1';
    var thumb = util.el('div', 'hp-thumb');
    thumb.dataset.pickerThumb = '1';
    if (hero) thumb.style.backgroundImage = 'url("' + util.avatarUrl(hero) + '")';
    box.appendChild(thumb);

    var name = util.el('div', 'hp-name');
    name.appendChild(document.createTextNode(hero ? hero.name : '未选择'));
    name.appendChild(util.el('small', '', hero ? (sub + ' · ' + (hero.title || '')) : sub));
    box.appendChild(name);

    var btn = util.el('button', 'btn btn-ghost', hero ? '换英雄' : '选择英雄');
    btn.type = 'button';
    btn.dataset.pickHero = kind;
    if (kind === 'player') {
      btn.dataset.side = side;
      btn.dataset.index = String(index);
    }
    box.appendChild(btn);

    if (hero) {
      var clr = util.el('button', 'btn btn-ghost', '清除');
      clr.type = 'button';
      clr.dataset.clearHero = kind;
      if (kind === 'player') { clr.dataset.side = side; clr.dataset.index = String(index); }
      box.appendChild(clr);
    }
    return box;
  }

  function syncHeroPickers() {
    /* 输入过程中只刷新英雄选择块的缩略图，不动输入框 */
    util.$$('[data-picker]', dom.body).forEach(function (box) {
      var btn = box.querySelector('[data-pick-hero]');
      if (!btn) return;
      var d = story.get();
      var hero = null;
      if (btn.dataset.pickHero === 'mvp') hero = d.mvp.heroId ? util.heroById(d.mvp.heroId) : null;
      else {
        var p = d.pre[btn.dataset.side].players[Number(btn.dataset.index)];
        hero = p && p.heroId ? util.heroById(p.heroId) : null;
      }
      var thumb = box.querySelector('[data-picker-thumb]');
      if (thumb) thumb.style.backgroundImage = hero ? 'url("' + util.avatarUrl(hero) + '")' : '';
      var nameEl = box.querySelector('.hp-name');
      if (nameEl && nameEl.firstChild) {
        nameEl.firstChild.nodeValue = hero ? hero.name : '未选择';
      }
    });
  }

  /* ---------- 赛前表单 ---------- */

  function buildPreForm(d) {
    var frag = document.createDocumentFragment();
    var p = d.pre;

    var sec0 = util.el('div', 'sd-section');
    sec0.appendChild(util.el('h4', '', '赛事信息'));
    var r0 = util.el('div', 'field-row');
    r0.appendChild(field('赛事名', d.event, 'event'));
    r0.appendChild(field('阶段', d.stage, 'stage'));
    sec0.appendChild(r0);
    var r0b = util.el('div', 'field-row');
    r0b.appendChild(field('对阵标题（可留空自动生成）', d.match, 'match'));
    r0b.appendChild(field('赛制', d.bestOf, 'bestOf', { placeholder: 'BO5' }));
    sec0.appendChild(r0b);
    frag.appendChild(sec0);

    ['blue', 'red'].forEach(function (side) {
      var t = p[side];
      var sec = util.el('div', 'sd-section');
      sec.appendChild(util.el('h4', '', (side === 'blue' ? '蓝方' : '红方') + '战队'));

      var r = util.el('div', 'field-row');
      r.appendChild(field('战队名', t.name, 'pre.' + side + '.name'));
      r.appendChild(field('排名/段位', t.rank, 'pre.' + side + '.rank', { placeholder: '常规赛第1' }));
      sec.appendChild(r);
      var r2 = util.el('div', 'field-row');
      r2.appendChild(field('胜率', t.winRate, 'pre.' + side + '.winRate', { placeholder: '78%' }));
      r2.appendChild(field('近期战绩', t.recent, 'pre.' + side + '.recent', { placeholder: '5胜1负' }));
      sec.appendChild(r2);

      /* 自定义情报 */
      (t.info || []).forEach(function (kv, i) {
        var row = util.el('div', 'stat-row');
        var l = document.createElement('input');
        l.type = 'text'; l.placeholder = '数据名'; l.value = kv.label || '';
        l.dataset.infoLabel = side + ':' + i;
        var v = document.createElement('input');
        v.type = 'text'; v.placeholder = '数值'; v.value = kv.value || '';
        v.dataset.infoValue = side + ':' + i;
        var del = util.el('button', 'del', '×');
        del.type = 'button';
        del.dataset.delInfo = side + ':' + i;
        row.appendChild(l); row.appendChild(v); row.appendChild(del);
        sec.appendChild(row);
      });
      var addInfo = util.el('button', 'btn btn-ghost', '+ 增加一条情报');
      addInfo.type = 'button';
      addInfo.dataset.addInfo = side;
      sec.appendChild(addInfo);
      frag.appendChild(sec);

      /* 五人名单 */
      var sec2 = util.el('div', 'sd-section');
      sec2.appendChild(util.el('h4', '', (side === 'blue' ? '蓝方' : '红方') + '选手（英雄留空则自动用本局 BP 结果）'));
      (t.players || []).forEach(function (pl, i) {
        var box = util.el('div', 'player-edit');
        var head = util.el('div', 'pe-head');
        head.appendChild(util.el('span', 'pe-pos', story.POSITIONS[i] || ('第' + (i + 1) + '位')));
        var idIn = document.createElement('input');
        idIn.type = 'text';
        idIn.placeholder = '选手 ID';
        idIn.value = pl.id || pl.name || '';
        idIn.dataset.playerId = side + ':' + i;
        head.appendChild(idIn);
        box.appendChild(head);
        box.appendChild(heroPicker('player', side, i));
        sec2.appendChild(box);
      });
      frag.appendChild(sec2);
    });

    var secH = util.el('div', 'sd-section');
    secH.appendChild(util.el('h4', '', '交锋史'));
    var rh = util.el('div', 'field-row');
    rh.appendChild(field('蓝方胜场', p.h2h.blueWins, 'pre.h2h.blueWins', { placeholder: '3' }));
    rh.appendChild(field('红方胜场', p.h2h.redWins, 'pre.h2h.redWins', { placeholder: '2' }));
    secH.appendChild(rh);
    secH.appendChild(field('备注', p.h2h.note, 'pre.h2h.note', { textarea: true, rows: 2 }));
    frag.appendChild(secH);

    var secU = util.el('div', 'sd-section');
    secU.appendChild(buildVisibilityRow('pre'));
    var useDraft = util.el('label', 'sd-hint');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p.useDraftPicks;
    cb.dataset.useDraft = '1';
    cb.style.marginRight = '6px';
    useDraft.appendChild(cb);
    useDraft.appendChild(document.createTextNode('英雄留空时，自动用本局 BP 选出的英雄补位'));
    secU.appendChild(useDraft);
    var applyBtn = util.el('button', 'btn btn-primary', '立即用 BP 结果填充空位');
    applyBtn.type = 'button';
    applyBtn.id = 'sdApplyPicks';
    secU.appendChild(applyBtn);
    frag.appendChild(secU);

    return frag;
  }

  /* ------------------------------------------------------------
     战绩表单：逐局记胜负，自动算大比分与冠军
     ------------------------------------------------------------ */
  function buildRecordForm(d) {
    var frag = document.createDocumentFragment();
    var rec = d.record || {};
    var pre = d.pre || {};

    /* 显示开关 + 面板信息 */
    var sec0 = util.el('div', 'sd-section');
    sec0.appendChild(util.el('h4', '', '战绩面板'));
    sec0.appendChild(util.el('div', 'sd-hint',
      '逐局点「蓝胜 / 红胜」即可，大比分和冠军会自动算。队名与头像取自「赛前面板」，不用重复填。'));
    sec0.appendChild(buildVisibilityRow('record'));
    var r0 = util.el('div', 'field-row');
    r0.appendChild(field('面板标题', rec.title, 'record.title', { placeholder: '留空显示「战 绩」' }));
    r0.appendChild(field('赛制', rec.bestOf, 'record.bestOf', { placeholder: '如 BO5' }));
    sec0.appendChild(r0);
    var r0b = util.el('div', 'field-row');
    r0b.appendChild(field('底部备注', rec.note, 'record.note', { placeholder: '可选' }));
    sec0.appendChild(r0b);
    frag.appendChild(sec0);

    /* 对阵双方（只读：改队名去赛前面板） */
    var sc = story.score(d);
    var secVs = util.el('div', 'sd-section');
    secVs.appendChild(util.el('h4', '', '对阵（队名 / 头像在「赛前面板」里改）'));
    var vs = util.el('div', 'rec-vs-row');
    [['blue', '蓝方'], ['red', '红方']].forEach(function (it) {
      var side = it[0];
      var t = pre[side] || {};
      var box = util.el('div', 'rec-vs-item is-' + side);
      var logo = util.el('div', 'rec-vs-logo');
      if (t.logo) {
        var img = document.createElement('img');
        img.src = t.logo;
        img.alt = '';
        logo.appendChild(img);
      } else {
        logo.appendChild(util.el('span', '', String(t.name || it[1]).slice(0, 1)));
      }
      box.appendChild(logo);
      box.appendChild(util.el('div', 'rec-vs-name', t.name || it[1]));
      box.appendChild(util.el('div', 'rec-vs-score', String(side === 'blue' ? sc.blue : sc.red)));
      vs.appendChild(box);
    });
    secVs.appendChild(vs);
    var win = story.winnerSide(d);
    secVs.appendChild(util.el('div', 'sd-hint', win
      ? ('当前获胜：' + ((win === 'blue' ? pre.blue.name : pre.red.name) || (win === 'blue' ? '蓝方' : '红方')))
      : '还没有分出胜负'));
    frag.appendChild(secVs);

    /* 逐局记胜负 */
    var secG = util.el('div', 'sd-section');
    secG.appendChild(util.el('h4', '', '每一局'));
    var games = (rec.games && rec.games.length) ? rec.games : [{ no: 1, winner: '' }];
    games.forEach(function (g) {
      var row = util.el('div', 'rec-game-row');
      row.appendChild(util.el('span', 'rg-label', '第 ' + g.no + ' 局'));
      var btns = util.el('div', 'rg-btns');
      [['blue', '蓝胜'], ['red', '红胜'], ['', '未打']].forEach(function (opt) {
        var on = (g.winner || '') === opt[0];
        var b = util.el('button', 'btn rg-btn' + (on ? ' on is-' + (opt[0] || 'none') : ''));
        b.type = 'button';
        b.textContent = opt[1];
        b.addEventListener('click', function () {
          story.setGameWinner(g.no, opt[0]);
          panel.refresh();
          broadcastOverlay();
        });
        btns.appendChild(b);
      });
      row.appendChild(btns);
      secG.appendChild(row);
    });

    var rowBtn = util.el('div', 'field-row');
    var syncBtn = util.el('button', 'btn btn-ghost', '按赛制对齐局数');
    syncBtn.type = 'button';
    syncBtn.title = '按「赛制」里的 BO 数增减局数（BO3 → 3 局）';
    syncBtn.addEventListener('click', function () {
      story.syncRecord();
      panel.refresh();
      broadcastOverlay();
    });
    rowBtn.appendChild(syncBtn);
    var addBtn = util.el('button', 'btn btn-ghost', '+ 加一局');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      var gs = story.get().record.games.slice();
      gs.push({ no: gs.length + 1, winner: '' });
      story.setRecord({ games: gs });
      panel.refresh();
      broadcastOverlay();
    });
    rowBtn.appendChild(addBtn);
    var clearBtn = util.el('button', 'btn btn-warn', '清空战绩');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', function () {
      if (!window.confirm('把所有局的胜负记录清空？')) return;
      var cur = story.get().record;
      story.setRecord({ games: cur.games.map(function (x) { return { no: x.no, winner: '' }; }) });
      panel.refresh();
      broadcastOverlay();
    });
    rowBtn.appendChild(clearBtn);
    secG.appendChild(rowBtn);
    frag.appendChild(secG);

    return frag;
  }

  function buildVisibilityRow(which) {
    var wrap = util.el('div', 'field-row');
    var on = util.el('button', 'btn btn-primary', '显示到采集窗');
    on.type = 'button';
    on.dataset.showOverlay = which;
    var off = util.el('button', 'btn btn-ghost', '隐藏');
    off.type = 'button';
    off.dataset.hideOverlay = which;
    var copy = util.el('button', 'btn btn-ghost', '打开采集窗');
    copy.type = 'button';
    copy.dataset.openOverlay = which;
    wrap.appendChild(on);
    wrap.appendChild(off);
    wrap.appendChild(copy);
    return wrap;
  }

  /* ---------------- 交互 ---------------- */

  function setByPath(path, value) {
    var parts = path.split('.');
    var patch = {};
    var cur = patch;
    for (var i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    story.patch(patch);
  }

  function onFieldInput(e) {
    var t = e.target;
    if (!t || !t.dataset) return;

    if (t.dataset.path) {
      setByPath(t.dataset.path, t.value);
      return;
    }
    if (t.dataset.statLabel !== undefined) {
      story.setStat(Number(t.dataset.statLabel), t.value, undefined);
      return;
    }
    if (t.dataset.statValue !== undefined) {
      story.setStat(Number(t.dataset.statValue), undefined, t.value);
      return;
    }
    if (t.dataset.infoLabel) {
      var a = t.dataset.infoLabel.split(':');
      story.raw().pre[a[0]].info[Number(a[1])].label = t.value;
      story.patch({}, false);
      return;
    }
    if (t.dataset.infoValue) {
      var b = t.dataset.infoValue.split(':');
      story.raw().pre[b[0]].info[Number(b[1])].value = t.value;
      story.patch({}, false);
      return;
    }
    if (t.dataset.playerId) {
      var c = t.dataset.playerId.split(':');
      story.setPlayer(c[0], Number(c[1]), { id: t.value });
      return;
    }
    if (t.dataset.useDraft) {
      story.patch({ pre: { useDraftPicks: !!t.checked } });
      return;
    }
  }

  function onBodyClick(e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t) return;

    /* 添加 / 删除战绩项 */
    if (t.dataset.addStat) {
      story.addStat(t.dataset.addStat);
      return;
    }
    if (t.dataset.delStat !== undefined) {
      story.removeStat(Number(t.dataset.delStat));
      return;
    }
    if (t.dataset.addInfo) {
      story.addTeamInfo(t.dataset.addInfo);
      return;
    }
    if (t.dataset.delInfo) {
      var di = t.dataset.delInfo.split(':');
      story.removeTeamInfo(di[0], Number(di[1]));
      return;
    }

    /* 英雄选择：进入「点左侧列表」的拾取模式 */
    if (t.dataset.pickHero) {
      heroPickTarget = t.dataset.pickHero === 'mvp'
        ? { kind: 'mvp' }
        : { kind: 'player', side: t.dataset.side, index: Number(t.dataset.index) };
      var h = WZ.ui && WZ.ui.hintPick ? WZ.ui.hintPick(true) : null;
      if (WZ.app && WZ.app.toast) {
        WZ.app.toast('请到左侧英雄列表点选英雄（再点一次「选择英雄」可取消）', 'warn', 3600);
      }
      return;
    }
    if (t.dataset.clearHero) {
      if (t.dataset.clearHero === 'mvp') story.setMvp({ heroId: null, skinIndex: 0 });
      /* 一并清掉自动填充标记，避免被 syncPicksWithDraft 当成 BP 自动填的格子回收 */
      else story.setPlayer(t.dataset.side, Number(t.dataset.index),
        { heroId: null, autoHeroId: null, skinIndex: 0 });
      return;
    }

    /* 覆盖层显示 / 隐藏 / 打开采集窗 */
    if (t.dataset.showOverlay) { broadcastOverlay(t.dataset.showOverlay, true); return; }
    if (t.dataset.hideOverlay) { broadcastOverlay(t.dataset.hideOverlay, false); return; }
    if (t.dataset.openOverlay) { openOverlayWindow(t.dataset.openOverlay); return; }

    if (t.id === 'sdApplyPicks') {
      var n = story.applyDraftPicks(true);
      if (WZ.app && WZ.app.toast) {
        WZ.app.toast(n ? ('已用本局 BP 结果填充 ' + n + ' 个位置') : '本局还没有选出英雄', n ? 'ok' : 'warn');
      }
      return;
    }
  }

  /* ---------------- 拾取模式：由 ui.js 在点英雄卡时回调 ---------------- */

  panel.isPicking = function () { return !!heroPickTarget; };

  panel.acceptPick = function (hero) {
    if (!heroPickTarget || !hero) return false;
    if (heroPickTarget.kind === 'mvp') {
      story.setMvp({ heroId: hero.id, skinIndex: 0 });
    } else {
      story.setPlayer(heroPickTarget.side, heroPickTarget.index, { heroId: hero.id, skinIndex: 0 });
    }
    heroPickTarget = null;
    if (WZ.ui && WZ.ui.hintPick) WZ.ui.hintPick(false);
    if (WZ.app && WZ.app.toast) WZ.app.toast('已选择 ' + hero.name, 'ok');
    panel.refresh();
    return true;
  };

  panel.cancelPick = function () {
    heroPickTarget = null;
    if (WZ.ui && WZ.ui.hintPick) WZ.ui.hintPick(false);
  };

  /* ---------------- 采集窗 ---------------- */

  function overlayUrl(mode) {
    var base = location.href.split('#')[0].split('?')[0];
    base = base.replace(/[^\/\\]*$/, '');
    return base + 'overlay.html?wzrole=overlay&mode=' + mode;
  }

  function openOverlayWindow(mode) {
    var w = window.open(overlayUrl(mode), 'wzbp-overlay-' + mode,
      'width=1280,height=760,menubar=no,toolbar=no,location=no,status=no');
    if (!w) {
      if (WZ.app && WZ.app.toast) WZ.app.toast('浏览器拦截了新窗口，请允许本站弹窗后重试', 'err', 4200);
      return;
    }
    overlayWin[mode] = w;
    try { w.focus(); } catch (e) { /* 忽略 */ }
    broadcastOverlay(mode, true);
    if (WZ.app && WZ.app.toast) {
      WZ.app.toast('采集窗已打开：OBS 采集它，这里继续改数据', 'ok', 4600);
    }
  }

  /* 广播覆盖层数据 + 显示状态 */
  function broadcastOverlay(mode, visible) {
    /* 直接改 raw 再 emit：story.patch() 会顺带触发一次表单重绘，没必要 */
    var raw = story.raw();
    if (mode === 'mvp' || mode === 'all') raw.mvp.visible = !!visible;
    if (mode === 'pre' || mode === 'all') raw.pre.visible = !!visible;
    if (mode === 'record' || mode === 'all') raw.record.visible = !!visible;
    story.saveNow();
    story.touch();

    if (WZ.sync) {
      WZ.sync.post({ t: 'overlay', payload: { mode: mode, visible: !!visible, story: story.get() } });
    }
    if (WZ.app && WZ.app.toast) {
      var name = mode === 'mvp' ? 'MVP 卡' : (mode === 'pre' ? '赛前面板' : (mode === 'record' ? '战绩面板' : '赛事面板'));
      WZ.app.toast(name + (visible ? '已显示到采集窗' : '已从采集窗隐藏'), 'ok');
    }
  }

  panel.broadcastAll = function () {
    if (!WZ.sync) return;
    WZ.sync.post({ t: 'overlay', payload: { mode: 'all', visible: true, story: story.get() } });
  };

  panel.openOverlayWindow = openOverlayWindow;

  WZ.storyPanel = panel;
})(window.WZ);
