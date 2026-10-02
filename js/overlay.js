/* ============================================================
   wzbp · 赛事覆盖层渲染
   ------------------------------------------------------------
   两个独立采集画面（都是 1600×900 设计稿，按窗口等比缩放）：
     · MVP 卡      —— 选手 ID / 英雄原画 / 战绩数据
     · 赛前面板    —— 双方队名、情报、五人位置与英雄、交锋史

   用法：
     #mvpOverlay / #preOverlay 容器写在 index.html 里，
     控制窗隐藏它们，独立采集页（overlay.html?mode=mvp|pre）只显示它们之一。
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var overlay = {};

  var DESIGN_W = 1600;
  var DESIGN_H = 900;
  var dom = {};
  var skinned = false;          // 采集页专用：切换显示哪个覆盖层

  overlay.init = function () {
    /* 两个覆盖层的容器 */
    dom.mvp = document.getElementById('mvpOverlay');
    dom.pre = document.getElementById('preOverlay');

    /* MVP 卡内部节点 */
    dom.mvpEvent = document.getElementById('mvpEvent');
    dom.mvpStage = document.getElementById('mvpStageLabel');
    dom.mvpGameNo = document.getElementById('mvpGameNo');
    dom.mvpPlayerId = document.getElementById('mvpPlayerId');
    dom.mvpRealName = document.getElementById('mvpRealName');
    dom.mvpTeam = document.getElementById('mvpTeam');
    dom.mvpPosition = document.getElementById('mvpPosition');
    dom.mvpSong = document.getElementById('mvpSong');
    dom.mvpArt = document.getElementById('mvpArt');
    dom.mvpHeroName = document.getElementById('mvpHeroName');
    dom.mvpHeroTitle = document.getElementById('mvpHeroTitle');
    dom.mvpHeroStage = document.getElementById('mvpHeroStage');
    dom.mvpStats = document.getElementById('mvpStats');
    dom.mvpEmpty = document.getElementById('mvpEmpty');

    /* 赛前面板内部节点 */
    dom.preEvent = document.getElementById('preEvent');
    dom.preStage = document.getElementById('preStageLabel');
    dom.preMatch = document.getElementById('preMatch');
    dom.preBestOf = document.getElementById('preBestOf');
    dom.preBlue = document.getElementById('preBlue');
    dom.preRed = document.getElementById('preRed');
    dom.preH2h = document.getElementById('preH2h');
    dom.preH2hBlue = document.getElementById('preH2hBlue');
    dom.preH2hRed = document.getElementById('preH2hRed');
    dom.preH2hNote = document.getElementById('preH2hNote');

    /* 战绩面板内部节点 */
    dom.rec = document.getElementById('recordOverlay');
    dom.recEvent = document.getElementById('recEvent');
    dom.recTitle = document.getElementById('recTitle');
    dom.recBo = document.getElementById('recBo');
    dom.recBlueName = document.getElementById('recBlueName');
    dom.recRedName = document.getElementById('recRedName');
    dom.recBlueWins = document.getElementById('recBlueWins');
    dom.recRedWins = document.getElementById('recRedWins');
    dom.recBlueLogo = document.getElementById('recBlueLogo');
    dom.recRedLogo = document.getElementById('recRedLogo');
    dom.recBlueFb = document.getElementById('recBlueFb');
    dom.recRedFb = document.getElementById('recRedFb');
    dom.recBlue = document.getElementById('recBlue');
    dom.recRed = document.getElementById('recRed');
    dom.recGames = document.getElementById('recGames');
    dom.recChampion = document.getElementById('recChampion');
    dom.recChampionText = document.getElementById('recChampionText');
    dom.recNote = document.getElementById('recNote');
    dom.recEmpty = document.getElementById('recEmpty');

    if (dom.mvpArt) util.bindImgFallback(dom.mvpArt, 'M');
    return overlay;
  };

  /* 采集页只显示其中一个覆盖层，并让它铺满窗口 */
  overlay.setMode = function (mode) {
    skinned = true;
    document.body.classList.add('overlay-page', 'overlay-' + mode);
    overlay.fit();
    window.addEventListener('resize', util.debounce(overlay.fit, 120));
  };

  overlay.fit = function () {
    var host = document.body.classList.contains('overlay-pre') ? dom.pre
      : (document.body.classList.contains('overlay-record') ? dom.rec : dom.mvp);
    if (!host) return;
    /* 顶部提示条占掉的高度要扣掉，否则整块会往下溢出被 overflow:hidden 切掉 */
    var flag = document.getElementById('displayFlag');
    var flagH = (flag && getComputedStyle(flag).display !== 'none')
      ? flag.getBoundingClientRect().height : 0;
    var availW = Math.max(320, window.innerWidth);
    var availH = Math.max(200, window.innerHeight - flagH);
    var scale = Math.min(availW / DESIGN_W, availH / DESIGN_H);
    scale = Math.max(0.2, Math.min(scale, 2.5));
    document.documentElement.style.setProperty('--overlay-scale', String(scale));
    document.documentElement.style.setProperty('--flag-h', flagH + 'px');
  };

  /* ---------------- 公共小工具 ---------------- */

  function setText(el, text) {
    if (el) el.textContent = (text === undefined || text === null) ? '' : String(text);
  }

  function show(el, on) {
    if (el) el.classList.toggle('is-off', !on);
  }

  function heroOf(id) { return id ? util.heroById(id) : null; }

  /* ---------------- MVP 卡 ---------------- */

  overlay.renderMvp = function (d) {
    if (!dom.mvp) return;
    var m = d.mvp || {};
    var hero = heroOf(m.heroId);

    setText(dom.mvpEvent, d.event);
    setText(dom.mvpStage, d.stage);
    setText(dom.mvpGameNo, m.gameNo);
    setText(dom.mvpPlayerId, m.playerId || '选手 ID');
    setText(dom.mvpRealName, m.realName);
    setText(dom.mvpTeam, m.team);
    setText(dom.mvpPosition, m.position);
    setText(dom.mvpSong, m.song);
    setText(dom.mvpHeroName, hero ? hero.name : '');
    setText(dom.mvpHeroTitle, hero ? (hero.title || '') : '');

    /* 原画 */
    if (dom.mvpArt) {
      var url = hero ? util.splashUrl(hero, m.skinIndex || 0) : '';
      if (url && dom.mvpArt.getAttribute('src') !== url) {
        dom.mvpArt.src = url;
        dom.mvpArt.alt = hero ? hero.name : '';
      }
      if (!url) dom.mvpArt.removeAttribute('src');
      dom.mvpArt.classList.toggle('hide', !url);
    }
    if (dom.mvpHeroStage) dom.mvpHeroStage.classList.toggle('no-art', !hero);

    /* 战绩 */
    var stats = (m.stats || []).filter(function (s) {
      return (s.label && String(s.label).trim()) || (s.value && String(s.value).trim());
    });
    if (dom.mvpStats) {
      dom.mvpStats.innerHTML = '';
      stats.forEach(function (s) {
        var item = util.el('div', 'mvp-stat');
        item.appendChild(util.el('div', 'ms-value', s.value || '—'));
        item.appendChild(util.el('div', 'ms-label', s.label || ''));
        dom.mvpStats.appendChild(item);
      });
      /* 数据项太多时自动缩小，保证不撑破卡片 */
      dom.mvpStats.classList.toggle('dense', stats.length > 4);
      dom.mvpStats.classList.toggle('denser', stats.length > 6);
    }

    /* 空态提示（只有自己看得到：采集页不显示） */
    if (dom.mvpEmpty) dom.mvpEmpty.hidden = !!(m.playerId || m.heroId);
  };

  /* ---------------- 赛前面板 ---------------- */

  function teamBlock(root, team, draftPicks) {
    if (!root) return;
    root.classList.toggle('is-blue', team.side === 'blue');
    root.classList.toggle('is-red', team.side === 'red');

    var nameEl = root.querySelector('.team-name');
    setText(nameEl, team.name || (team.side === 'blue' ? '蓝方' : '红方'));

    var meta = root.querySelector('.team-meta');
    if (meta) {
      meta.innerHTML = '';
      [['胜率', team.winRate], ['近期', team.recent], ['段位/排名', team.rank]]
        .forEach(function (pair) {
          if (!pair[1]) return;
          var chip = util.el('span', 'tm-chip');
          chip.appendChild(util.el('b', '', pair[0]));
          chip.appendChild(document.createTextNode(' ' + pair[1]));
          meta.appendChild(chip);
        });
      (team.info || []).forEach(function (kv) {
        if (!kv || (!kv.label && !kv.value)) return;
        var chip = util.el('span', 'tm-chip');
        chip.appendChild(util.el('b', '', kv.label || ''));
        chip.appendChild(document.createTextNode(' ' + (kv.value || '')));
        meta.appendChild(chip);
      });
    }

    var list = root.querySelector('.team-players');
    if (!list) return;
    list.innerHTML = '';
    (team.players || []).forEach(function (p, i) {
      var slot = util.el('div', 'pre-player');
      var hero = heroOf(p.heroId) || heroOf(draftPicks && draftPicks[i]);
      var art = util.el('div', 'pp-art');
      if (hero) {
        art.style.backgroundImage = 'url("' + util.splashUrl(hero, p.skinIndex || 0) + '")';
        slot.classList.add('filled');
      }
      slot.appendChild(art);
      slot.appendChild(util.el('div', 'pp-veil'));

      var body = util.el('div', 'pp-body');
      var idEl = util.el('div', 'pp-id', p.id || p.name || '');
      if (!p.id && !p.name) idEl.classList.add('is-empty');
      var heroEl = util.el('div', 'pp-hero', hero ? hero.name : '待定');
      var posEl = util.el('div', 'pp-pos', p.position || WZ.story.POSITIONS[i] || '');
      body.appendChild(idEl);
      body.appendChild(heroEl);
      if (posEl.textContent) body.appendChild(posEl);
      slot.appendChild(body);

      /* 选手个人数据（可空） */
      var ps = (p.stats || []).filter(function (s) { return s.label || s.value; });
      if (ps.length) {
        var bar = util.el('div', 'pp-stats');
        ps.forEach(function (s) {
          var c = util.el('span', 'pp-stat');
          c.appendChild(util.el('b', '', s.value || '—'));
          c.appendChild(document.createTextNode(' ' + (s.label || '')));
          bar.appendChild(c);
        });
        slot.appendChild(bar);
      }
      list.appendChild(slot);
    });
  }

  overlay.renderPre = function (d) {
    if (!dom.pre) return;
    var p = d.pre || {};
    setText(dom.preEvent, d.event);
    setText(dom.preStage, d.stage);
    setText(dom.preMatch, d.match || (p.blue.name && p.red.name ? p.blue.name + ' vs ' + p.red.name : ''));
    setText(dom.preBestOf, d.bestOf);

    /* 本局 BP 的 pick 用来补空位 */
    var picks = { blue: [], red: [] };
    if (p.useDraftPicks && WZ.draft && WZ.draft.state()) {
      var st = WZ.draft.state();
      picks.blue = st.picks.blue || [];
      picks.red = st.picks.red || [];
    }

    teamBlock(dom.preBlue, p.blue || {}, picks.blue);
    teamBlock(dom.preRed, p.red || {}, picks.red);

    var h = p.h2h || {};
    setText(dom.preH2hBlue, h.blueWins);
    setText(dom.preH2hRed, h.redWins);
    setText(dom.preH2hNote, h.note);
    show(dom.preH2h, !!(h.blueWins || h.redWins || h.note));
  };

  /* ---------------- 战绩面板（谁赢了） ---------------- */

  overlay.renderRecord = function (d) {
    if (!dom.rec) return;
    var rec = (d && d.record) || {};
    var pre = (d && d.pre) || {};
    var sc = WZ.story && WZ.story.score ? WZ.story.score(d) : { blue: 0, red: 0, played: 0, total: 0 };
    var winner = WZ.story && WZ.story.winnerSide ? WZ.story.winnerSide(d) : '';

    var blueName = (pre.blue && pre.blue.name) || '蓝方';
    var redName = (pre.red && pre.red.name) || '红方';

    setText(dom.recEvent, d && d.event);
    setText(dom.recTitle, rec.title || '战 绩');
    setText(dom.recBlueName, blueName);
    setText(dom.recRedName, redName);
    setText(dom.recBlueWins, String(sc.blue));
    setText(dom.recRedWins, String(sc.red));
    setText(dom.recBo, rec.bestOf || (d && d.bestOf) || (sc.total ? 'BO' + sc.total : ''));
    setText(dom.recNote, rec.note);

    /* 战队头像（没有就用队名首字占位） */
    logoInto(dom.recBlueLogo, dom.recBlueFb, (pre.blue && pre.blue.logo) || '', blueName);
    logoInto(dom.recRedLogo, dom.recRedFb, (pre.red && pre.red.logo) || '', redName);

    /* 领先/获胜方高亮 */
    if (dom.recBlue) {
      dom.recBlue.classList.toggle('is-ahead', sc.blue > sc.red);
      dom.recBlue.classList.toggle('is-champion', winner === 'blue');
    }
    if (dom.recRed) {
      dom.recRed.classList.toggle('is-ahead', sc.red > sc.blue);
      dom.recRed.classList.toggle('is-champion', winner === 'red');
    }

    /* 冠军横幅 */
    if (dom.recChampion) {
      dom.recChampion.hidden = !winner;
      if (winner) setText(dom.recChampionText, (winner === 'blue' ? blueName : redName) + ' 获胜');
    }

    /* 每一局的结果 */
    if (dom.recGames) {
      dom.recGames.innerHTML = '';
      var games = rec.games || [];
      var shows = games.filter(function (g) { return g && (g.winner || true); });
      if (!shows.length) {
        var ph = document.createElement('div');
        ph.className = 'rg-empty';
        ph.textContent = '还没有记录任何一局';
        dom.recGames.appendChild(ph);
      } else {
        games.forEach(function (g, i) {
          var cell = document.createElement('div');
          cell.className = 'rg-cell' + (g.winner === 'blue' ? ' win-blue'
            : (g.winner === 'red' ? ' win-red' : ' pending'));
          var no = document.createElement('div');
          no.className = 'rg-no';
          no.textContent = '第 ' + (g.no || i + 1) + ' 局';
          var w = document.createElement('div');
          w.className = 'rg-win';
          w.textContent = g.winner === 'blue' ? '蓝胜' : (g.winner === 'red' ? '红胜' : '—');
          cell.appendChild(no);
          cell.appendChild(w);
          dom.recGames.appendChild(cell);
        });
      }
    }

    show(dom.recEmpty, !rec.visible);
  };

  /* 把 logo 塞进 <img>，没有/坏了就把首字占位显示出来。
     注意 display 要显式设成 'block'：样式表里 .rs-logo img 默认是 display:none，
     只把 style.display 清成 '' 是压不过样式表的（之前就是这么没显示出来的）。 */
  function logoInto(img, fb, src, name) {
    if (!img || !fb) return;
    setText(fb, String(name || '?').slice(0, 1));
    if (!src) {
      img.removeAttribute('src');
      img.style.display = 'none';
      fb.style.display = '';
      return;
    }
    if (img.getAttribute('src') !== src) img.src = src;
    img.style.display = 'block';
    fb.style.display = 'none';
    img.onerror = function () {
      img.style.display = 'none';
      fb.style.display = '';
    };
  }

  /* ---------------- 统一入口 ---------------- */

  overlay.render = function (d) {
    if (!d) return;
    overlay.renderMvp(d);
    overlay.renderPre(d);
    overlay.renderRecord(d);
  };

  /* 采集页：只渲染对应那一个，另一个保持隐藏 */
  overlay.renderFor = function (mode, d) {
    if (mode === 'mvp') overlay.renderMvp(d);
    else if (mode === 'pre') overlay.renderPre(d);
    else if (mode === 'record') overlay.renderRecord(d);
    else overlay.render(d);
  };

  WZ.overlay = overlay;
})(window.WZ);
