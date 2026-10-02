/* ============================================================
   wzbp · 赛事面板数据（MVP 卡 / 赛前面板）
   ------------------------------------------------------------
   两个覆盖层的数据都存在这里，统一序列化，方便：
     · 控制窗表单编辑
     · 独立采集页（mvp.html?mode=mvp|pre）渲染
     · 跨窗口同步（塞进 sync 的 payload.overlay）
     · 存 localStorage，刷新不丢
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = WZ.util;
  var story = {};

  var LS_KEY = 'wzbp.story.v1';
  var listeners = [];

  var DEFAULT_STATS = [
    { label: 'KDA', value: '' },
    { label: '输出占比', value: '' },
    { label: '参团率', value: '' },
    { label: '经济', value: '' }
  ];

  /* 表单里可一键添加的常用数据项 */
  story.STAT_PRESETS = [
    'KDA', '击杀', '死亡', '助攻', '输出占比', '承伤占比', '参团率',
    '经济', '经济占比', '对塔伤害', '推塔数', '视野得分', '治疗量', '关键控制'
  ];

  story.POSITIONS = ['对抗路', '打野', '中路', '发育路', '游走'];

  function blankPlayer() {
    /* autoHeroId：这一格的英雄是不是由 BP 自动填的（用于撤销时精确回收）。
       手填/手改过的格子 autoHeroId 对不上，不会被回收。 */
    return { id: '', name: '', heroId: null, autoHeroId: null, skinIndex: 0, stats: [] };
  }

  function blankTeam(name, side) {
    return {
      side: side,
      name: name,
      logo: '',
      /* 赛前情报 */
      winRate: '', recent: '', rank: '',
      info: [],                       // [{label, value}]
      players: [0, 1, 2, 3, 4].map(function () { return blankPlayer(); })
    };
  }

  function defaults() {
    return {
      /* ---- 共用：赛事信息 ---- */
      event: '',                 // 赛事名，如「2026 KPL 春季赛」
      stage: '',                 // 阶段，如「常规赛 第 3 周」
      match: '',                 // 对阵，如「AG超玩会 vs 重庆狼队」
      bestOf: '',                // 赛制，如「BO5」
      /* ---- MVP 卡 ---- */
      mvp: {
        visible: false,
        playerId: '',            // 选手 ID / 昵称
        realName: '',            // 真实姓名（可选）
        team: '',                // 所属战队
        position: '',            // 位置
        heroId: null,
        skinIndex: 0,
        gameNo: '',              // 第几局，如「第一局」
        song: '',                // 一句话点评（原本想叫 slogan）
        stats: DEFAULT_STATS.map(function (s) { return { label: s.label, value: s.value }; })
      },
      /* ---- 赛前面板 ---- */
      pre: {
        visible: false,
        blue: blankTeam('', 'blue'),
        red: blankTeam('', 'red'),
        /* 两队交锋史 */
        h2h: { blueWins: '', redWins: '', note: '' },
        /* 自动用本局 BP 结果填充双方英雄 */
        useDraftPicks: true
      },
      /* ---- 战绩面板 ----
         games：每一局的胜方（'blue' | 'red' | '' 未记）
         visible：是否在采集画面上显示
         title：面板标题（留空则用「赛事名 · 大比分」自动生成） */
      record: {
        visible: false,
        title: '',
        bestOf: '',                 // 如「BO5」，留空则跟 story.bestOf
        games: [ { no: 1, winner: '' } ],
        note: ''                    // 底部一行备注
      }
    };
  }

  /* 大比分：从每局胜方累加 */
  story.score = function (d) {
    d = d || data;
    var gs = (d.record && d.record.games) || [];
    var b = 0, r = 0;
    gs.forEach(function (g) {
      if (g.winner === 'blue') b++;
      else if (g.winner === 'red') r++;
    });
    return { blue: b, red: r, played: gs.filter(function (g) { return !!g.winner; }).length, total: gs.length };
  };

  /* 谁赢了整场：先看有没有一方达到「BO几 的过半」，否则看谁领先 */
  story.winnerSide = function (d) {
    d = d || data;
    var sc = story.score(d);
    var boRaw = String((d.record && d.record.bestOf) || d.bestOf || '').replace(/[^0-9]/g, '');
    var bo = Number(boRaw) || 0;
    var need = bo ? Math.floor(bo / 2) + 1 : 0;
    if (need) {
      if (sc.blue >= need) return 'blue';
      if (sc.red >= need) return 'red';
      return '';
    }
    if (sc.blue > sc.red) return 'blue';
    if (sc.red > sc.blue) return 'red';
    return '';
  };

  /* 确保 record.games 长度与 bestOf 对得上（BO3 → 最多 3 局） */
  story.syncRecordGames = function (d) {
    d = d || data;
    var boRaw = String((d.record && d.record.bestOf) || d.bestOf || '').replace(/[^0-9]/g, '');
    var bo = Math.max(1, Math.min(9, Number(boRaw) || 1));
    var rec = d.record || (d.record = { visible: false, title: '', bestOf: '', games: [], note: '' });
    var gs = Array.isArray(rec.games) ? rec.games : [];
    var out = [];
    for (var i = 0; i < bo; i++) {
      var g = gs[i] || {};
      out.push({ no: i + 1, winner: (g.winner === 'blue' || g.winner === 'red') ? g.winner : '' });
    }
    rec.games = out;
    return rec;
  };

  var data = defaults();

  /* ---------------- 读写 ---------------- */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function emit() {
    var snap = story.get();
    listeners.forEach(function (fn) {
      try { fn(snap); } catch (e) { console.error('[story] listener error', e); }
    });
  }

  story.get = function () { return clone(data); };
  story.raw = function () { return data; };

  story.on = function (fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  /* 深合并写入：patch 里只出现的字段会被覆盖，其余保留 */
  story.patch = function (patch, silent) {
    data = merge(clone(data), patch || {});
    if (!silent) { save(); emit(); }
    return story.get();
  };

  function merge(base, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        merge(base[k], v);
      } else {
        base[k] = v;
      }
    });
    return base;
  }

  story.reset = function () {
    data = defaults();
    save();
    emit();
    return story.get();
  };

  /* 外部直接改了 raw 之后，用它通知订阅者重绘 */
  story.touch = function () { emit(); };

  /* ---------------- 持久化 ---------------- */

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { util.store.set(LS_KEY, JSON.stringify(data)); } catch (e) { /* 忽略 */ }
    }, 120);
  }
  story.saveNow = save;

  story.load = function () {
    var raw = util.store.get(LS_KEY);
    if (!raw) return false;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return false;
      /* 用 defaults 兜底，防止旧版本存档缺字段 */
      data = merge(defaults(), parsed);
      emit();
      return true;
    } catch (e) { return false; }
  };

  /* ---------------- MVP ---------------- */

  story.setMvp = function (patch) {
    return story.patch({ mvp: patch });
  };

  story.addStat = function (label) {
    data.mvp.stats.push({ label: label || '', value: '' });
    save(); emit();
    return story.get().mvp.stats;
  };

  story.removeStat = function (index) {
    if (index < 0 || index >= data.mvp.stats.length) return;
    data.mvp.stats.splice(index, 1);
    save(); emit();
    return story.get().mvp.stats;
  };

  story.setStat = function (index, label, value) {
    var s = data.mvp.stats[index];
    if (!s) return;
    if (label !== undefined && label !== null) s.label = label;
    if (value !== undefined && value !== null) s.value = value;
    save(); emit();
  };

  /* ---------------- 赛前 ---------------- */

  story.setPre = function (patch) {
    return story.patch({ pre: patch });
  };

  story.setTeam = function (side, patch) {
    var t = data.pre[side];
    if (!t) return story.get();
    Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
    save(); emit();
    return story.get();
  };

  story.setPlayer = function (side, index, patch) {
    var t = data.pre[side];
    if (!t || !t.players[index]) return story.get();
    Object.keys(patch).forEach(function (k) { t.players[index][k] = patch[k]; });
    save(); emit();
    return story.get();
  };

  /* ------------------------------------------------------------
     战绩面板
     ------------------------------------------------------------ */

  story.setRecord = function (patch) {
    patch = patch || {};
    var rec = data.record || (data.record = { visible: false, title: '', bestOf: '', games: [], note: '' });
    Object.keys(patch).forEach(function (k) {
      if (k === 'games') return;                 // games 走 setGameWinner，避免整段覆盖
      rec[k] = patch[k];
    });
    if (patch.bestOf !== undefined) story.syncRecordGames(data);
    save(); emit();
    return story.get();
  };

  /* 记某一局的胜方；winner 传 '' 表示清掉这局 */
  story.setGameWinner = function (no, winner) {
    var rec = story.syncRecordGames(data);
    var idx = Math.max(0, Number(no) - 1);
    if (!rec.games[idx]) return story.get();
    rec.games[idx].winner = (winner === 'blue' || winner === 'red') ? winner : '';
    save(); emit();
    return story.get();
  };

  /* 让记录局数与 BO 对齐（切 BO 时调用） */
  story.syncRecord = function () {
    story.syncRecordGames(data);
    save(); emit();
    return story.get();
  };

  story.addTeamInfo = function (side) {
    data.pre[side].info.push({ label: '', value: '' });
    save(); emit();
    return story.get().pre[side].info;
  };

  story.removeTeamInfo = function (side, index) {
    data.pre[side].info.splice(index, 1);
    save(); emit();
    return story.get().pre[side].info;
  };

  /* ---------------- 与 BP 结果联动 ---------------- */

  /* 把本局 BP 的双方 5 个 pick 填进赛前面板。
     · 默认（force=false）：只填空位，手填过的位置不动
     · force=true：**先整体清空再回填**
     自动填的位置会记下 autoHeroId 作为「这一格是 BP 给的」的标记，
     以便 BP 撤销/改选时能精确回收（见 syncPicksWithDraft）。 */
  story.applyDraftPicks = function (force) {
    if (!WZ.draft) return 0;
    var st = WZ.draft.state();
    if (!st) return 0;
    var filled = 0;
    ['blue', 'red'].forEach(function (side) {
      var picks = st.picks[side] || [];
      for (var i = 0; i < 5; i++) {
        var p = data.pre[side].players[i];
        if (!p) continue;
        if (force) { p.heroId = null; p.autoHeroId = null; }
        if (p.heroId) continue;                // 非 force 时此处即「已填，跳过」
        if (picks[i] === undefined || picks[i] === null) continue;
        p.heroId = picks[i];
        p.autoHeroId = picks[i];               // 打标记：这格是 BP 自动填的
        p.skinIndex = 0;
        filled++;
      }
    });
    save(); emit();
    return filled;
  };

  /* BP 发生撤销 / 重做 / 重开时调用：把赛前面板上由 BP 自动填、
     但现在已经不在本局里的英雄回收掉（手填的位置不动）。

     早先的版本用「面板上的英雄是否还出现在本局 picks 里」来判断，
     结果本局少选了几手时（picks 变短），超出的那几格永远命中不了条件，
     失效英雄就留在面板上清不掉——所以改成显式标记 autoHeroId。 */
  story.syncPicksWithDraft = function () {
    if (!WZ.draft) return 0;
    var st = WZ.draft.state();
    if (!st) return 0;
    var changed = 0;
    ['blue', 'red'].forEach(function (side) {
      var picks = (st.picks[side] || []).map(String);
      for (var i = 0; i < 5; i++) {
        var p = data.pre[side].players[i];
        if (!p || !p.heroId) continue;
        /* 只看「由 BP 自动填进去、且没被手改过」的格子 */
        var autoId = p.autoHeroId === undefined ? null : p.autoHeroId;
        if (autoId === null) continue;                       // 手填的，不动
        if (String(autoId) !== String(p.heroId)) continue;   // 被手改过，不动
        if (String(picks[i]) === String(p.heroId)) continue; // 本局该位置仍是它
        /* 本局这个位置已经换人 / 还没选到 → 回收 */
        p.heroId = null;
        p.autoHeroId = null;
        p.skinIndex = 0;
        changed++;
      }
    });
    if (changed) { save(); emit(); }
    return changed;
  };

  /* 在 BP 每次变化后调用：先清掉失效位置，再补齐空位。
     这样赛前面板既不会留下已经不在本局里的英雄，
     也不需要用户手动点「填充」——真正做到跟随 BP 走。
     useDraftPicks 关掉时完全不动面板。 */
  story.syncFromDraft = function () {
    var d = story.get();
    if (!d.pre.useDraftPicks) return 0;
    var cleared = story.syncPicksWithDraft();
    var filled = story.applyDraftPicks(false);
    return cleared + filled;
  };

  /* ---------------- 导出 / 导入 ---------------- */

  story.exportData = function () {
    return {
      app: 'wzbp-story', version: 1,
      exportedAt: new Date().toISOString(),
      data: clone(data)
    };
  };

  story.importData = function (raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: '数据格式错误' };
    var payload = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (!payload.mvp && !payload.pre) return { ok: false, reason: '不是赛事面板数据' };
    data = merge(defaults(), payload);
    save();
    emit();
    return { ok: true };
  };

  /* ---------------- 便捷判定 ---------------- */

  story.mvpReady = function () {
    return !!(data.mvp.heroId || data.mvp.playerId);
  };

  story.preReady = function () {
    return !!(data.pre.blue.name || data.pre.red.name ||
      data.pre.blue.players.some(function (p) { return p.heroId; }) ||
      data.pre.red.players.some(function (p) { return p.heroId; }));
  };

  WZ.story = story;
})(window.WZ);
