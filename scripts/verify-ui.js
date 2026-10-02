/* ============================================================
   wzbp · 浏览器端冒烟测试（临时文件，验证后删除）
   ------------------------------------------------------------
   在真实的 file:// 环境下加载 index.html 的脚本与 DOM，
   驱动完整一局 BP，检查 DOM 是否真的被正确更新，
   并验证官网图片是否真的加载成功（这是数据是否可用的关键）。
   用法：
     node scripts/_smoke-build.mjs     生成
     chrome --headless=new --dump-dom 读取 #smokeOut
   ============================================================ */
window.__SMOKE__ = (function () {
  'use strict';

  var lines = [];
  var pass = 0, fail = 0;

  function ok(cond, label, extra) {
    if (cond) { pass++; lines.push('PASS | ' + label); }
    else { fail++; lines.push('FAIL | ' + label + (extra ? ' | ' + extra : '')); }
  }
  function eq(a, b, label) {
    var sa = JSON.stringify(a), sb = JSON.stringify(b);
    ok(sa === sb, label, sa === sb ? '' : 'got ' + sa + ' want ' + sb);
  }
  function info(s) { lines.push('INFO | ' + s); }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadImage(url, timeout) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, err: 'timeout' }); } }, timeout || 15000);
      img.onload = function () { if (!done) { done = true; clearTimeout(t); resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); } };
      img.onerror = function () { if (!done) { done = true; clearTimeout(t); resolve({ ok: false, err: 'error' }); } };
      img.src = url;
    });
  }

  async function run() {
    /* 注意：本文件在 </body> 之前加载，此刻 WZ 命名空间尚未建立，
       所有引用必须等到 run() 执行时再取。 */
    var WZ = window.WZ;
    var util = WZ.util;
    /* ---------- 1. 数据层 ---------- */
    ok(!!(WZ.HEROES && WZ.HEROES.length), 'heroes.js 已加载且有数据',
      'count=' + ((WZ.HEROES || []).length));
    var heroes = WZ.HEROES || [];
    info('英雄数量 = ' + heroes.length);
    eq(heroes.length, 133, '英雄数量 = 133（官网当前值）');

    var first = heroes[0];
    ok(!!first.name && !!first.id, '英雄字段完整（第一条）');
    var badField = heroes.filter(function (h) {
      return !h.id || !h.name || !h.avatar || !h.roles || !h.roles.length;
    });
    eq(badField.length, 0, '所有英雄都有 id/name/avatar/roles');

    var idUnique = {}, dup = 0;
    heroes.forEach(function (h) { if (idUnique[h.id]) dup++; idUnique[h.id] = 1; });
    eq(dup, 0, '英雄 id 无重复');

    var nameUnique = {}, dupN = 0;
    heroes.forEach(function (h) { if (nameUnique[h.name]) dupN++; nameUnique[h.name] = 1; });
    eq(dupN, 0, '英雄名无重复');

    var pyMissing = heroes.filter(function (h) { return !h.pinyin || !h.pinyin.variants || !h.pinyin.variants.length; });
    eq(pyMissing.length, 0, '所有英雄都有拼音搜索串');

    /* 数据层契约：splash 是从 skins 里剔除 404 后得到的，所以只能 <= skins
       （王维/大禹/卢雅那 3 位的大图官网就是 404，splash 为空数组） */
    var splashOver = heroes.filter(function (h) { return (h.splash || []).length > (h.skins || []).length; });
    eq(splashOver.length, 0, 'splash 数量不超过皮肤数量');
    var noArt = heroes.filter(function (h) { return (h.splash || []).length === 0; });
    ok(noArt.length <= 5, '无原画的英雄数量在预期内（' + noArt.length + '：' +
      noArt.map(function (h) { return h.name; }).join('/') + '）');

    /* ---------- 2. 真实图片加载（官网 CDN） ---------- */
    var avatarTests = [heroes[0], heroes[60], heroes[heroes.length - 1]];
    for (var i = 0; i < avatarTests.length; i++) {
      var h = avatarTests[i];
      var got = await loadImage(h.avatar);
      ok(got.ok && got.w > 0, '官网头像可加载：' + h.name, got.ok ? (got.w + 'x' + got.h) : got.err);
    }
    /* 原画抽查 3 张 */
    var arts = [heroes[0], heroes[30], heroes[heroes.length - 1]];
    for (var j = 0; j < arts.length; j++) {
      var hh = arts[j];
      if (!hh.splash || !hh.splash.length) { ok(false, '原画地址存在：' + hh.name, 'splash 为空'); continue; }
      var g2 = await loadImage(hh.splash[0]);
      ok(g2.ok && g2.w > 0, '官网原画可加载：' + hh.name, g2.ok ? (g2.w + 'x' + g2.h) : g2.err);
    }

    /* 跨域 canvas 不污染（截图功能的前提） */
    try {
      var c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      var ctx = c.getContext('2d');
      var im = await new Promise(function (res, rej) {
        var t = new Image();
        t.crossOrigin = 'anonymous';
        t.onload = function () { res(t); };
        t.onerror = function () { rej(new Error('load error')); };
        t.src = heroes[0].avatar;
      });
      ctx.drawImage(im, 0, 0, 8, 8);
      var d = ctx.getImageData(0, 0, 8, 8);
      ok(d.data.length === 256, '跨域图片可绘制到 canvas 并读像素（截图可用）');
    } catch (e) {
      ok(false, '跨域图片可绘制到 canvas 并读像素（截图可用）', e.name + ': ' + e.message);
    }

    /* ---------- 3. 技能数据 ---------- */
    var skills = WZ.SKILLS || {};
    var skillCount = Object.keys(skills).length;
    info('技能条目数 = ' + skillCount);
    ok(skillCount > 0, 'skills.js 已加载');
    if (skillCount) {
      var firstKey = Object.keys(skills)[0];
      var sample = skills[firstKey];
      ok(!!sample.name && !!sample.passive && Array.isArray(sample.skills) && sample.skills.length >= 3,
        '技能结构完整（抽查 ' + sample.name + '）');
      var badShape = Object.keys(skills).filter(function (k) {
        var s = skills[k];
        return !s.name || !s.passive || !s.passive.name || !s.passive.desc ||
          !Array.isArray(s.skills) || s.skills.length < 3 ||
          s.skills.some(function (x) { return !x.name || !x.desc; });
      });
      eq(badShape.length, 0, '所有英雄技能结构完整（共 ' + skillCount + ' 位）');
      var dirty = 0;
      Object.keys(skills).forEach(function (k) {
        var s = skills[k];
        var all = [s.passive && s.passive.desc || ''].concat((s.skills || []).map(function (x) { return x.desc || ''; }));
        all.forEach(function (t) { if (/[<>]|&nbsp;|&amp;|&#\d/.test(t)) dirty++; });
      });
      eq(dirty, 0, '技能描述无 HTML 标签/实体残留');
      /* 8 位英雄官网原文就是 4 个主动技能，面板必须能全部显示 */
      var four = Object.keys(skills).filter(function (k) { return skills[k].skills.length === 4; });
      info('4 技能英雄数量 = ' + four.length + '（' + four.map(function (k) { return skills[k].name; }).join('/') + '）');
      ok(four.length > 0, '保留官网的 4 技能英雄，未被截断');
    }

    /* ---------- 4. 页面启动状态 ---------- */
    ok(!!document.querySelector('.hero-card'), '英雄网格已渲染');
    var cards = document.querySelectorAll('.hero-card').length;
    info('首屏英雄卡数量 = ' + cards);
    eq(cards, 133, '全部英雄都渲染成卡片');
    eq(document.querySelectorAll('#banLaneBlue .ban-slot').length, 5, '蓝方 ban 位 DOM 存在（单侧上限 5，KPL 用得到）');
    eq(document.querySelectorAll('#pickLaneBlue .pick-slot').length, 5, '蓝方 pick 位 = 5');
    eq(document.querySelectorAll('#pickLaneRed .pick-slot').length, 5, '红方 pick 位 = 5');
    ok(document.querySelector('#boardMode').textContent.length > 0, '展示板标题已渲染',
      document.querySelector('#boardMode').textContent);

    /* ---------- 5. 搜索交互 ---------- */
    var input = document.getElementById('searchInput');
    input.value = 'lianpo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    var shown = document.querySelectorAll('.hero-card').length;
    ok(shown >= 1 && shown < 10, '拼音搜索能过滤（lianpo → ' + shown + ' 个）');
    var firstName = document.querySelector('.hero-card .hc-name');
    eq(firstName ? firstName.textContent : null, '廉颇', '拼音搜索首位是廉颇');

    input.value = '不存在xx';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    ok(document.getElementById('gridEmpty').hidden === false, '无结果时显示空态');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    eq(document.querySelectorAll('.hero-card').length, 133, '清空搜索后恢复全部');

    /* ---------- 6. 分路筛选 ---------- */
    var roleBtn = document.querySelectorAll('#roleFilter button')[1];
    var roleName = roleBtn.textContent;
    roleBtn.click();
    await wait(220);
    var filtered = document.querySelectorAll('.hero-card').length;
    ok(filtered > 0 && filtered < 133, '分路筛选生效（' + roleName + ' → ' + filtered + '）');
    document.querySelectorAll('#roleFilter button')[0].click();
    await wait(220);

    /* 分路 / 定位标签是否都进了筛选项 */
    var chipLabels = Array.prototype.map.call(document.querySelectorAll('#roleFilter button'),
      function (b) { return b.textContent.replace(/\d+$/, ''); });
    ['对抗路', '打野', '中路', '发育路', '游走', '坦克', '战士', '刺客', '法师', '射手', '辅助']
      .forEach(function (tag) {
        ok(chipLabels.some(function (c) { return c === tag; }), '筛选项包含「' + tag + '」');
      });

    /* ---------- 7. 完整一局 BP（点按钮走完全流程） ---------- */
    var D = WZ.draft;
    D.init('ranked');
    var teamPick = { blue: [], red: [] }, teamBan = { blue: [], red: [] };

    for (var step = 0; step < 40; step++) {
      var s = D.state();
      if (s.done) break;
      var side = s.stepInfo.side === 'both' ? 'blue' : s.stepInfo.side;
      var action = s.stepInfo.action;
      var pool = s.pool;
      var id = pool[0];
      var r = D.apply(side, action, id);
      ok(r.ok, '第 ' + (s.step + 1) + ' 步执行成功（' + side + ' ' + action + '）', r.reason || '');
      if (r.ok) {
        if (action === 'ban') teamBan[side].push(id); else teamPick[side].push(id);
      }
    }

    var end = D.state();
    eq(end.done, true, '赛程走完');
    eq(end.step, 16, '牌位模式下共 16 步');

    /* DOM 是否真的反映了 BP */
    await wait(450);
    var blueImgs = document.querySelectorAll('#pickLaneBlue .pick-slot.filled').length;
    var redImgs = document.querySelectorAll('#pickLaneRed .pick-slot.filled').length;
    eq(blueImgs, 5, '蓝方 5 个 pick 卡已填充');
    eq(redImgs, 5, '红方 5 个 pick 卡已填充');
    var banFilled = document.querySelectorAll('#banLaneBlue .ban-slot.filled').length +
      document.querySelectorAll('#banLaneRed .ban-slot.filled').length;
    eq(banFilled, 6, '6 个 ban 位已填充');
    var blueName = document.querySelector('#pickLaneBlue .ps-name').textContent;
    ok(blueName && blueName.length > 0, '蓝方一选名字已渲染', blueName);
    var banShown = document.querySelectorAll('#banLaneBlue .ban-slot').length;
    info('蓝方 ban 位渲染数量 = ' + banShown + '（征召模式应为 3）');
    var visibleBan = Array.prototype.filter.call(document.querySelectorAll('#banLaneBlue .ban-slot'),
      function (n) { return n.style.display !== 'none'; }).length;
    eq(visibleBan, 3, '征召模式只显示 3 个蓝方 ban 位');
    ok(document.querySelector('#boardStatus').textContent.indexOf('已完成') >= 0, '状态条显示已完成');

    /* 中央大图：最后一个 pick 应该显示出来 */
    var splashSrc = document.querySelector('#stageSplash').getAttribute('src') || '';
    ok(splashSrc.indexOf('bigskin') >= 0, '中央大图已设置为官网原画', splashSrc.slice(-42));

    /* ---------- 8. 重复英雄被拒绝（DOM 层面） ---------- */
    D.init('ranked');
    var already = D.apply('blue', 'ban', teamBan.blue[0]);
    ok(already.ok, '重开后第一步正常');
    var same = D.apply('red', 'ban', teamBan.blue[0]);
    ok(!same.ok, '同一英雄二次 ban 被拒绝');

    /* ---------- 9. 撤销 / 重做（DOM 同步） ---------- */
    D.init('ranked');
    D.apply('blue', 'ban', heroes[0].id);
    D.apply('red', 'ban', heroes[1].id);
    await wait(200);
    eq(document.querySelectorAll('.ban-slot.filled').length, 2, '两步后 2 个 ban 位填充');
    document.getElementById('btnUndo').click();
    await wait(220);
    eq(document.querySelectorAll('.ban-slot.filled').length, 1, '点撤销后 DOM 回到 1 个 ban');
    document.getElementById('btnRedo').click();
    await wait(220);
    eq(document.querySelectorAll('.ban-slot.filled').length, 2, '点重做后 DOM 回到 2 个 ban');

    /* ---------- 10. 全局 BP 模式切换（B2P3 → B3P2，每队 5 ban + 5 pick） ---------- */
    var kplBtn = Array.prototype.filter.call(document.querySelectorAll('#modeSwitch button'),
      function (b) { return b.dataset.mode === 'kpl'; })[0];
    ok(!!kplBtn, '全局 BP 模式按钮存在');
    if (kplBtn) {
      window.confirm = function () { return true; };
      kplBtn.click();
      await wait(250);
      eq(D.state().mode, 'kpl', '已切到全局 BP');
      eq(D.state().totalSteps, 18, '全局 BP 共 18 手');
      var visBlue = Array.prototype.filter.call(document.querySelectorAll('#banLaneBlue .ban-slot'),
        function (n) { return n.style.display !== 'none'; }).length;
      eq(visBlue, 4, '全局 BP 显示 4 个蓝方 ban 位');
      ok(/全局\s*BP/.test(document.querySelector('#boardMode').textContent),
        '展示板标题切到全局 BP', document.querySelector('#boardMode').textContent);
      /* 用户明确要求：赛制标题就叫「全局 BP」，不要带 B2P3 之类的细节 */
      eq(document.querySelector('#boardMode').textContent.trim(), '全局 BP', '标题就是「全局 BP」');
    }

    /* ---------- 10b. 战队名：控制台能改、展示板能显示、展示窗能同步 ---------- */
    {
      eq(!!WZ.board.setTeamNames, true, 'board 暴露了 setTeamNames');
      var bar = document.getElementById('teamNameBar');
      ok(!!bar, '控制台里有战队名输入条');
      var tb = document.getElementById('tnbInput-blue');
      var tr = document.getElementById('tnbInput-red');
      ok(!!tb && !!tr, '蓝红两个战队名输入框都在');

      if (tb && tr && WZ.app && WZ.app.setTeamName) {
        tb.value = '成都AG超玩会';
        tb.dispatchEvent(new Event('input', { bubbles: true }));
        tr.value = '上海EDG.M';
        tr.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(260);

        var heads = {
          blue: document.querySelector('#pickLaneBlue .team-head-name'),
          red: document.querySelector('#pickLaneRed .team-head-name')
        };
        ok(!!heads.blue && !!heads.red, '展示板上两栏都有战队名节点');
        eq(heads.blue.textContent, '成都AG超玩会', '蓝方战队名显示在展示板上');
        eq(heads.red.textContent, '上海EDG.M', '红方战队名显示在展示板上');
        ok(document.querySelector('#pickLaneBlue .team-head').classList.contains('is-custom'),
          '有真实队名时加了 is-custom 样式（与占位区分）');
        /* 同步载荷要带上战队名，展示窗才能显示 */
        ok(WZ.app.snapshotForTest && WZ.app.snapshotForTest().teamNames &&
           WZ.app.snapshotForTest().teamNames.blue === '成都AG超玩会',
          '同步载荷里带上了战队名');

        /* 清空后要回退成「蓝方/红方」，不留空白 */
        tb.value = '';
        tb.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(200);
        eq(document.querySelector('#pickLaneBlue .team-head-name').textContent, '蓝方',
          '清空队名后回退显示「蓝方」');
      }
      /* 超长队名不能把横条撑破 */
      if (WZ.board.setTeamNames) {
        WZ.board.setTeamNames({ blue: '一个非常非常非常长的战队名字测试', red: '' });
        await wait(120);
        var longHead = document.querySelector('#pickLaneBlue .team-head-name');
        eq(longHead.textContent, '一个非常非常非常长的战队名字测试', '超长队名仍完整显示');
        ok(parseInt(longHead.style.fontSize, 10) > 0 &&
           parseInt(longHead.style.fontSize, 10) <= 30, '超长队名会缩小字号',
          'fontSize=' + longHead.style.fontSize);
        WZ.board.setTeamNames({ blue: '', red: '' });
      }
    }

    /* ---------- 10c. 战队头像 ---------- */
    {
      ok(typeof WZ.board.setTeams === 'function', 'board 暴露了 setTeams（名字 + 头像）');
      var logoBtn = document.querySelector('#teamNameBar .tnb-logo');
      ok(!!logoBtn, '控制台里战队名旁边有头像按钮');
      var fileInput = document.querySelector('#teamNameBar .tnb-file');
      ok(!!fileInput && fileInput.type === 'file', '头像按钮配了 file 选择器');

      /* 1x1 红点 PNG，够小、能验证「图片真的进了 <img>」 */
      var dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABSElEQVR4nO3by3GDMBSF4XP/ZrLPMtWkCJeRIlJNltmnGmfrYcAWQuh1+Ha2QbpHQgxjW9LFW9Ts7OP7fk857uczqtUVPQRuOSDRa+hagxGjBD9rIGK04KUHgpHDl6iBVh2XdKSWqNlZj0uCmcLn1MhZDbe0p1ZKN9iL1JqROWac/T21c7SB3r3KQO6JI3mWBZmLUrP/e3tTTe9ff0UekpA5Zl77KdmQOWQOl8t/KyMyh8whczit/7WsyBwyh8whc8gcMofMIXPIHC3+ltLaY1ZkDplD5nh84XAfWGZE5pA5lm/MvAyuX4ZWhDbM9hXZ1pWNzLH1wUz3gmdZyD1xFK8ycLSBnqXUjsyRctCIV0FqzZRusAd7auWshlvZW2PkdtTbg1Lu5FC7wzMcqYVWHZdytIYoVYjtpqkl221zayw3To62dfYic/+U7o9ssBR62QAAAABJRU5ErkJggg==';
      if (WZ.app && WZ.app.setTeamLogo) {
        WZ.app.setTeamLogo('blue', dot);
        await wait(260);
        var bImg = document.querySelector('#pickLaneBlue .team-head-logo img');
        var bHead = document.querySelector('#pickLaneBlue .team-head');
        ok(!!bImg, '蓝方战队名横条里有头像 <img>');
        eq(bImg.getAttribute('src'), dot, '头像 src 与设置的一致');
        ok(bHead.classList.contains('has-logo'), '有头像时横条加上 has-logo');
        eq(bHead.querySelector('.team-head-logo-fb').textContent, '蓝', '占位首字用的是队名首字');

        /* 同步载荷要带上头像，展示窗才能显示 */
        var snap = WZ.app.snapshotForTest ? WZ.app.snapshotForTest() : null;
        ok(snap && snap.teams && snap.teams.blue && snap.teams.blue.logo === dot,
          '同步载荷里带上了战队头像');

        /* 清除后要回到首字占位，不留破图 */
        WZ.app.setTeamLogo('blue', '');
        await wait(220);
        var bHead2 = document.querySelector('#pickLaneBlue .team-head');
        ok(!bHead2.classList.contains('has-logo'), '清除头像后去掉 has-logo');
        ok(!bHead2.querySelector('img').getAttribute('src'), '清除后 <img> 不再持有 src');
      }
      /* 坏图不能显示成破图 */
      if (WZ.board.setTeams) {
        WZ.board.setTeams({ blue: { name: '测试队', logo: 'data:image/png;base64,NOTVALID' },
                            red: { name: '', logo: '' } });
        await wait(200);
        eq(document.querySelector('#pickLaneBlue .team-head-name').textContent, '测试队',
          '坏头像不影响队名显示');
        WZ.board.setTeams({ blue: { name: '', logo: '' }, red: { name: '', logo: '' } });
      }
    }
    /* ---------- 11. 导出 / 导入 round-trip ---------- */
    D.init('ranked');
    for (var k = 0; k < 5; k++) {
      var st2 = D.state();
      D.apply(st2.stepInfo.side, st2.stepInfo.action, st2.pool[0]);
    }
    var dump = D.exportData();
    var jsonOk = true;
    try { JSON.stringify(dump); } catch (e) { jsonOk = false; }
    ok(jsonOk, '导出数据可 JSON 序列化');
    D.init('ranked');
    var imp = D.importData(JSON.parse(JSON.stringify(dump)));
    ok(imp.ok && imp.applied === 5, '导入还原 5 步', 'applied=' + imp.applied);
    eq(D.state().picks.blue.concat(D.state().picks.red).length,
      dump.picks.blue.length + dump.picks.red.length, '导入后 pick 数一致');

    /* 分享码 */
    var code = D.shareCode();
    var share = D.applyShareCode(code);
    ok(share.ok, '分享码可还原');

    /* ---------- 11b. 全局 BP 的 5 个 ban 位都要有位置可放 ---------- */
    if (kplBtn) {
      D.init('kpl');
      await wait(200);
      /* 第一轮 B2P3：双方各 2 个 ban，共 4 个 */
      for (var kb = 0; kb < 4; kb++) {
        var ss = D.state();
        var rr = D.apply(ss.stepInfo.side === 'both' ? 'blue' : ss.stepInfo.side,
          ss.stepInfo.action, ss.pool[0]);
        if (!rr.ok) break;
      }
      await wait(300);
      var kplBanFilled = document.querySelectorAll('#banLaneBlue .ban-slot.filled').length +
        document.querySelectorAll('#banLaneRed .ban-slot.filled').length;
      eq(kplBanFilled, 4, '第一轮（B2P3）4 个 ban 全部渲染出来');
      /* 打通到第二轮 ban 全部落位（每队累计 5 个） */
      var guard2 = 0;
      while (!D.state().done && guard2++ < 40) {
        var st3 = D.state();
        if (st3.stepInfo.action === 'pick' && st3.bans.blue.length >= 4 && st3.bans.red.length >= 4) break;
        var r3 = D.apply(st3.stepInfo.side === 'both' ? 'blue' : st3.stepInfo.side,
          st3.stepInfo.action, st3.pool[0]);
        if (!r3.ok) break;
      }
      await wait(350);
      var blueBanFilled = document.querySelectorAll('#banLaneBlue .ban-slot.filled').length;
      var redBanFilled = document.querySelectorAll('#banLaneRed .ban-slot.filled').length;
      var visBlueBans = Array.prototype.filter.call(document.querySelectorAll('#banLaneBlue .ban-slot'),
        function (n) { return n.style.display !== 'none'; }).length;
      ok(visBlueBans >= 4, '全局 BP 下展示板为单侧预留了 ≥4 个 ban 位', '可见 ' + visBlueBans + ' 个');
      eq(blueBanFilled + redBanFilled, 8,
        '两轮共 8 个 ban 全部落在展示板上（累计填充 ' + (blueBanFilled + redBanFilled) + ' 个）');
      eq(blueBanFilled, Math.min(D.state().cap.blue.ban, D.state().bans.blue.length),
        '蓝方填满的 ban 位数量与实际 ban 数一致');
    }

    /* ---------- 11c. 全局 BP 池在 UI 上要看得见 ---------- */
    {
      D.init('kpl');
      D.setGlobalUsed({ blue: [105], red: [106] });
      await wait(300);
      var st4 = D.state();
      eq(st4.global, true, '状态里标记了当前是全局 BP');
      eq(st4.globalUsed.blue, [105], '状态里带出蓝方已用英雄');
      /* 详情面板上这两个英雄的对应按钮应被禁用（全局 BP 不能重选） */
      WZ.ui.selectHero(105);
      await wait(350);
      var pickBlueBtn = document.querySelector('#sidePanel .pv-actions button[data-action="pick"][data-side="blue"]');
      ok(!!pickBlueBtn, '找得到蓝方选择按钮');
      if (pickBlueBtn) {
        ok(pickBlueBtn.disabled === true || /全局/.test(pickBlueBtn.title || ''),
          '蓝方已用过的英雄，蓝方不能再选（按钮禁用或给出原因）',
          'disabled=' + pickBlueBtn.disabled + ' title=' + (pickBlueBtn.title || ''));
      }
      D.setGlobalUsed({ blue: [], red: [] });
    }

    /* ---------- 12. 直播模式 / 缩放 ---------- */
    document.getElementById('btnBossMode').click();
    await wait(300);
    ok(document.body.classList.contains('boss'), '直播模式已开启');
    var consoleHidden = getComputedStyle(document.getElementById('console')).display === 'none';
    ok(consoleHidden, '直播模式下控制台隐藏');
    var boardRevealed = getComputedStyle(document.getElementById('heroGrid')).display !== 'none';
    ok(boardRevealed, '展示板仍在');
    var scale = getComputedStyle(document.documentElement).getPropertyValue('--board-scale').trim();
    ok(parseFloat(scale) > 0, '展示板缩放比已计算', 'scale=' + scale);
    document.getElementById('btnBossMode').click();
    await wait(200);
    ok(!document.body.classList.contains('boss'), '直播模式已关闭');

    /* ---------- 13. 倒计时 ---------- */
    document.getElementById('btnTimer30').click();
    await wait(400);
    var clock = document.getElementById('clock').textContent;
    ok(/^00:(2[0-9]|30)$/.test(clock), '倒计时开始读数', clock);
    var boardClock = document.getElementById('boardClock').textContent;
    ok(/^00:(2[0-9]|30)$/.test(boardClock), '展示板时钟同步', boardClock);
    document.getElementById('btnTimerReset').click();
    await wait(200);
    eq(document.getElementById('clock').textContent, '00:00', '归零');

    /* ---------- 14. 截图能力 ---------- */
    ok(typeof window.html2canvas === 'function', 'html2canvas 已加载（本地 vendored）',
      typeof window.html2canvas);

    /* ---------- 15. 视口内布局（两种断点分开判） ---------- */
    var vh = window.innerHeight;
    var gridEl = document.getElementById('heroGrid');
    var gridRect = gridEl.getBoundingClientRect();
    ok(gridRect.bottom <= vh + 1, '英雄网格不溢出视口底部',
      'bottom=' + Math.round(gridRect.bottom) + ' vh=' + vh);

    WZ.ui.selectHero(WZ.HEROES[0].id);
    await wait(400);
    var actBtns = document.querySelectorAll('#sidePanel .pv-actions button[data-action]');
    eq(actBtns.length, 4, '详情面板渲染了 4 个 ban/pick 按钮');

    /* 宽屏是左右两栏，按钮必须「不用滚动就能点」；
       窄屏（≤1100px）会堆叠成一栏，面板本来就在网格下方，此时只要求滚动后能点到。 */
    var cols = getComputedStyle(document.querySelector('.console-body'))
      .gridTemplateColumns.split(' ').filter(function (s) { return s.length; });
    if (cols.length > 1) {
      var panelRect = document.getElementById('sidePanel').getBoundingClientRect();
      ok(panelRect.bottom <= vh + 1, '两栏布局：详情面板不溢出视口底部',
        'bottom=' + Math.round(panelRect.bottom) + ' vh=' + vh);
      var overflowBtns = Array.prototype.filter.call(actBtns, function (b) {
        return b.getBoundingClientRect().bottom > vh + 1;
      });
      eq(overflowBtns.length, 0, '两栏布局：4 个动作按钮无需滚动即可点击');
    } else {
      actBtns[0].scrollIntoView({ block: 'center' });
      await wait(250);
      var r0 = actBtns[0].getBoundingClientRect();
      var hit = document.elementFromPoint(r0.left + r0.width / 2, r0.top + r0.height / 2);
      ok(!!hit && (hit === actBtns[0] || actBtns[0].contains(hit)),
        '单列布局：滚动后第一个动作按钮可命中（确实能点到）',
        hit ? (hit.tagName + '.' + hit.className) : 'null');
      ok(r0.bottom <= vh + 1, '单列布局：滚动后按钮进入视口',
        'bottom=' + Math.round(r0.bottom) + ' vh=' + vh);
    }

    /* 技能：4 技能英雄必须全部显示出来，不能被截成 3 条 */
    var fourSkillHero = null;
    Object.keys(WZ.SKILLS || {}).forEach(function (k) {
      if (!fourSkillHero && WZ.SKILLS[k].skills.length === 4) fourSkillHero = WZ.SKILLS[k];
    });
    if (fourSkillHero) {
      WZ.ui.selectHero(fourSkillHero.ename);
      await wait(350);
      var shownSkills = document.querySelectorAll('#sidePanel .pv-skills .skill-item').length;
      ok(shownSkills >= 5, '4 技能英雄（' + fourSkillHero.name + '）显示 1 被动 + 4 技能',
        '实渲染 ' + shownSkills + ' 条');
    }

    /* ---------- 16. 双窗口：打开展示窗按钮与角色识别 ---------- */
    ok(!!document.getElementById('btnOpenDisplay'), '顶栏有「打开展示窗」按钮');
    ok(!document.body.classList.contains('role-display'), '默认不是展示窗模式');
    var flagEl = document.getElementById('displayFlag');
    ok(!!flagEl, '展示窗标记条元素存在');
    ok(getComputedStyle(flagEl).display === 'none', '控制窗不显示展示窗标记条');
    ok(!!window.WZ.sync, 'js/sync.js 已加载');
    eq(window.WZ.sync.isDisplay(), false, 'sync 判定当前为控制窗');
    /* 展示窗模式下：控制台必须隐藏、标记条必须出现 */
    document.body.classList.add('role-display');
    await wait(150);
    ok(getComputedStyle(document.getElementById('console')).display === 'none',
      'role-display 下控制台隐藏');
    ok(getComputedStyle(flagEl).display !== 'none', 'role-display 下标记条出现');
    document.body.classList.remove('role-display');

    /* ---------- 17. 快捷键与监听器只能注册一次（回归：曾经绑了两遍） ---------- */
    {
      D.init('ranked');
      await wait(250);
      /* 包一层计数：一次操作应该只触发一次 render / 一次广播 */
      var counts = { render: 0, posts: 0 };
      var origRender = WZ.board.render;
      WZ.board.render = function () { counts.render++; return origRender.apply(this, arguments); };
      var origPost = WZ.sync.post;
      WZ.sync.post = function (m) {
        if (m && (m.t === 'update' || m.t === 'snapshot')) counts.posts++;
        return origPost.apply(this, arguments);
      };

      var s = D.state();
      D.apply(s.stepInfo.side, s.stepInfo.action, s.pool[0]);
      await wait(300);
      eq(counts.render, 1, '一次 BP 动作只触发一次展示板渲染（不是两次）');
      eq(counts.posts, 1, '一次 BP 动作只广播一次（不是两次）');

      /* Ctrl+Z 一次只能退一步 */
      D.apply('red', 'ban', D.state().pool[0]);
      await wait(250);
      var beforeStep = D.state().step;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await wait(300);
      eq(D.state().step, beforeStep - 1, 'Ctrl+Z 只退一步（不是两步）',
        'step ' + beforeStep + ' → ' + D.state().step);

      /* Ctrl+Y 一次只能进一步 */
      var beforeRedo = D.state().step;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
      await wait(300);
      eq(D.state().step, beforeRedo + 1, 'Ctrl+Y 只进一步', 'step ' + beforeRedo + ' → ' + D.state().step);

      /* 空格必须真的把表跑起来（曾因绑两次而立刻被第二次调用暂停） */
      document.getElementById('btnTimer30').click();
      await wait(200);
      var started = document.getElementById('btnTimerStart').textContent;
      var clock0 = document.getElementById('clock').textContent;
      await wait(1200);
      var clock1 = document.getElementById('clock').textContent;
      ok(started === '暂停', '点 30s 后进入运行态', started);
      ok(clock1 !== clock0, '倒计时确实在走', clock0 + ' → ' + clock1);
      document.getElementById('btnTimerReset').click();
      await wait(250);

      WZ.board.render = origRender;
      WZ.sync.post = origPost;
    }

    lines.unshift('SUMMARY | pass=' + pass + ' fail=' + fail);
    return lines;
  }

  return { run: run };
})();
