/* ============================================================
   wzbp · 共享工具
   ------------------------------------------------------------
   纯静态站点：所有模块挂在 window.WZ 命名空间下，
   用普通 <script> 加载（file:// 协议禁止 ES module 与 fetch）。
   ============================================================ */
window.WZ = window.WZ || {};

(function (WZ) {
  'use strict';

  var util = {};

  /* ---------- DOM ---------- */

  util.$ = function (sel, root) { return (root || document).querySelector(sel); };
  util.$$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  util.el = function (tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  util.esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  util.attr = function (s) {
    return util.esc(s).replace(/`/g, '&#96;');
  };

  /* ---------- 杂项 ---------- */

  util.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  util.stamp = function (d) {
    d = d || new Date();
    return d.getFullYear() + util.pad2(d.getMonth() + 1) + util.pad2(d.getDate()) +
      '-' + util.pad2(d.getHours()) + util.pad2(d.getMinutes()) + util.pad2(d.getSeconds());
  };

  util.debounce = function (fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait || 120);
    };
  };

  /* ---------- UTF-8 安全的 base64（用于分享码） ---------- */

  util.b64encode = function (str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  util.b64decode = function (b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  /* 把 base64 转成 URL 安全的短码 */
  util.toUrlSafe = function (b64) {
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  util.fromUrlSafe = function (s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return s;
  };

  /* ---------- 存储（file:// / 隐私模式下可能不可用，全部兜底） ---------- */

  var memStore = {};
  util.store = {
    get: function (k) {
      try { var v = window.localStorage.getItem(k); return v === null ? undefined : v; }
      catch (e) { return memStore[k]; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, v); } catch (e) { memStore[k] = v; }
    },
    del: function (k) {
      try { window.localStorage.removeItem(k); } catch (e) { delete memStore[k]; }
    }
  };

  /* ---------- 下载 ---------- */

  util.download = function (filename, blobOrText, mime) {
    var blob = (blobOrText instanceof Blob)
      ? blobOrText
      : new Blob([blobOrText], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  };

  util.copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy failed'));
      } catch (e) { reject(e); }
    });
  };

  /* ---------- 英雄搜索 ---------- */
  /* 契约：heroes.js 只提供 WZ.HEROES / WZ.HERO_META。
     搜索实现放在这里，避免与数据生成脚本耦合。

     排序优先级：
       0 · 名称前缀   1 · 拼音前缀   2 · 名称子串
       3 · 全拼子串   4 · 其它变体子串   5 · 定位/分路子串
     同权重按 ename/官网 id 升序。 */

  function heroes() { return WZ.HEROES || []; }

  function norm(s) { return String(s === undefined || s === null ? '' : s).trim().toLowerCase(); }

  function pinyinStrings(hero) {
    var p = hero.pinyin || {};
    var out = [];
    if (p.full) out.push(norm(p.full));
    if (p.idName) out.push(norm(p.idName));
    if (p.initials) out.push(norm(p.initials));
    if (Array.isArray(p.variants)) {
      for (var i = 0; i < p.variants.length; i++) out.push(norm(p.variants[i]));
    }
    out.push(norm(hero.idName));
    /* 去重去空 */
    var seen = {}, res = [];
    for (var j = 0; j < out.length; j++) {
      var v = out[j];
      if (v && !seen[v]) { seen[v] = 1; res.push(v); }
    }
    return res;
  }

  /* 预建索引，避免每次输入都重算 */
  var index = null;
  function buildIndex() {
    index = heroes().map(function (h) {
      return {
        hero: h,
        name: norm(h.name),
        py: pinyinStrings(h),
        tags: (h.roles || []).concat(h.types || []).map(norm)
      };
    });
  }

  util.searchHeroes = function (query, opts) {
    opts = opts || {};
    var all = heroes();
    if (!all.length) return [];
    if (!index || index.length !== all.length) buildIndex();

    var q = norm(query);
    var list = index;

    /* 分路过滤：tag 命中任一即可 */
    var tag = opts.role && opts.role !== 'all' ? norm(opts.role) : null;
    var pool = tag ? list.filter(function (e) { return e.tags.indexOf(tag) !== -1; }) : list;

    if (!q) return pool.map(function (e) { return e.hero; });

    var scored = [];
    for (var i = 0; i < pool.length; i++) {
      var e = pool[i], rank = -1;

      if (e.name.indexOf(q) === 0) rank = 0;
      else {
        for (var a = 0; a < e.py.length; a++) {
          if (e.py[a].indexOf(q) === 0) { rank = 1; break; }
        }
        if (rank < 0 && e.name.indexOf(q) !== -1) rank = 2;
        if (rank < 0) {
          for (var b = 0; b < e.py.length; b++) {
            if (e.py[b].indexOf(q) !== -1) { rank = 4; break; }
          }
        }
        if (rank < 0) {
          for (var c = 0; c < e.tags.length; c++) {
            if (e.tags[c].indexOf(q) !== -1) { rank = 5; break; }
          }
        }
      }
      if (rank >= 0) scored.push({ e: e, r: rank });
    }

    scored.sort(function (x, y) {
      if (x.r !== y.r) return x.r - y.r;
      return (x.e.hero.id || 0) - (y.e.hero.id || 0);
    });
    return scored.map(function (s) { return s.e.hero; });
  };

  util.heroById = function (id) {
    if (typeof WZ.heroById === 'function') {
      var h = WZ.heroById(id);
      if (h) return h;
    }
    var all = heroes();
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(id)) return all[i];
    }
    return null;
  };

  /* 头像 / 原画地址：数据里已给绝对 URL；缺失时按官网规则兜底拼接 */
  util.avatarUrl = function (hero) {
    if (!hero) return '';
    if (hero.avatar) return hero.avatar;
    return 'https://game.gtimg.cn/images/yxzj/img201606/heroimg/' + hero.id + '/' + hero.id + '.jpg';
  };

  util.splashes = function (hero) {
    if (!hero) return [];
    /* 数据层已经逐条 HEAD 校验过 splash：数组存在（哪怕为空）就以它为准，
       只有字段整体缺失时才按官网命名规则兜底拼接。
       注意别用 skins.length 反推——有 3 位英雄的大图确实是 404，会拼出死链。 */
    if (Array.isArray(hero.splash)) return hero.splash;
    var n = Math.max((hero.skins || []).length, 1), out = [];
    for (var i = 1; i <= n; i++) {
      out.push('https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/' +
        hero.id + '/' + hero.id + '-bigskin-' + i + '.jpg');
    }
    return out;
  };

  util.splashUrl = function (hero, index) {
    var s = util.splashes(hero);
    if (!s.length) return '';
    var i = Math.min(Math.max(index || 0, 0), s.length - 1);
    return s[i];
  };

  /* 图片加载失败时的兜底：显示首字 */
  util.bindImgFallback = function (img, label) {
    img.addEventListener('error', function () {
      img.classList.add('img-failed');
      if (!img.dataset.failed) {
        img.dataset.failed = '1';
        var holder = document.createElement('span');
        holder.className = 'img-fallback';
        holder.textContent = String(label || '?').slice(0, 1);
        if (img.parentNode) img.parentNode.insertBefore(holder, img.nextSibling);
      }
    });
  };

  util.preload = function (url) {
    if (!url) return;
    var i = new Image();
    i.decoding = 'async';
    i.src = url;
  };

  /* 侧别 / 动作的中文文案 */
  util.SIDE_LABEL = { blue: '蓝方', red: '红方' };
  util.ACTION_LABEL = { ban: '禁用', pick: '选择' };

  WZ.util = util;
})(window.WZ);
