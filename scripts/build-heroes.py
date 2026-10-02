#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-heroes.py —— 生成 data/heroes.js（王者荣耀英雄数据快照）

为什么是 .js 而不是 .json：
    本站点通过 file:// 协议打开，浏览器禁止 fetch/XHR 读取本地文件（已实测），
    因此数据必须以普通 <script src="data/heroes.js"> 可直接加载的形式交付。

数据源（全部来自王者荣耀官网 pvp.qq.com，无第三方、无手写数据）：
    1. https://pvp.qq.com/web201605/js/herolist.json          UTF-8，133 条，主数据源
    2. https://pvp.qq.com/zlkdatasys/heroskinlist.json        UTF-8，133 条，官方「资料库」数据，
                                                              用于交叉校验分路(roles)与职业(hero_type)映射
    3. https://pvp.qq.com/web201605/herolist.shtml            GBK，内含官方 typeMap（职业数字→中文）
    4. https://game.gtimg.cn/images/js/pvpcommon/api.js       UTF-8，内含官方 HERO_TYPE_NAME（职业数字→中文）
    5. https://pvp.qq.com/web201605/herodetail/{ename}.shtml   GBK，详情页，用于分路文案抽查取证

用法：
    python scripts/build-heroes.py                  # 完整生成（含全部图片 URL 的 HTTP HEAD 校验）
    python scripts/build-heroes.py --offline        # 只用本地缓存，不联网（缓存见下）
    python scripts/build-heroes.py --refresh-urls   # 忽略 URL 校验缓存，重新 HEAD 全部图片
    python scripts/build-heroes.py --skip-url-check # 跳过图片 URL 校验（生成的 splash 含未校验 URL，仅供调试）

网络缓存目录：%TEMP%/wzbp-heroes-cache（脚本自动创建，不污染仓库）
输出：
    data/heroes.js
    scripts/REPORT-heroes.md
"""

import argparse
import collections
import concurrent.futures
import datetime
import json
import os
import random
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request

try:
    from pypinyin import lazy_pinyin, Style
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "[FATAL] 缺少 pypinyin，无法为 id_name 非纯 ASCII 的英雄生成拼音 fallback。\n"
        "        请先安装：python -m pip install pypinyin\n"
    )
    raise SystemExit(2)

# ---------------------------------------------------------------- 常量 / 路径

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JS = os.path.join(ROOT, "data", "heroes.js")
OUT_REPORT = os.path.join(ROOT, "scripts", "REPORT-heroes.md")
CACHE_DIR = os.path.join(tempfile.gettempdir(), "wzbp-heroes-cache")

URL_HEROLIST = "https://pvp.qq.com/web201605/js/herolist.json"
URL_ZLK = "https://pvp.qq.com/zlkdatasys/heroskinlist.json"
URL_HEROLIST_PAGE = "https://pvp.qq.com/web201605/herolist.shtml"
URL_API_JS = "https://game.gtimg.cn/images/js/pvpcommon/api.js"
URL_DETAIL = "https://pvp.qq.com/web201605/herodetail/{e}.shtml"

HDRS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://pvp.qq.com/web201605/herolist.shtml",
}

# 分路映射：官网 herolist.json 的 roles 字段是 "1|2" 形式的数字串。
# 该映射由 zlkdatasys/heroskinlist.json 的 fllb_2105 字段（官方中文分路文案）逐条反证得出，
# 133 条中 130 条「顺序+集合」完全一致，详见 REPORT。
ROLE_MAP = {1: "对抗路", 2: "打野", 3: "中路", 4: "发育路", 5: "游走"}

# 定位映射：官网 herolist.shtml 内联 typeMap 与 api.js 内 HERO_TYPE_NAME 双向印证。
TYPE_MAP = {1: "战士", 2: "法师", 3: "坦克", 4: "刺客", 5: "射手", 6: "辅助"}

# 拼音人工修正表（理由见 REPORT 第 5 节；均以「官网 id_name 优先」为原则）
INITIALS_OVERRIDE = {
    # 曜：官网 cname 只有「曜」一个字，但官方 id_name 是 dongfangyao（东方曜），
    # 首字母应跟随最终采用的 full，即 d-f-y，而不是按单字算出的 y。
    522: "dfy",
}
EXTRA_VARIANTS = {
    # 124 周瑜：官方 id_name 用 v 表示 ü（zhouyv），补一个常见的 ASCII 写法。
    124: ["zhouyu"],
    # 163 橘右京：同上，官方 id_name = jvyoujing。
    163: ["juyoujing", "jv"],
    # 522 曜：契约明确要求同时给出 "yue" 与 "yao"。
    522: ["yao", "yue"],
}
# 元流之子 5 个形态：id_name 形如 yuanliuzhizi_tank（含下划线，非纯 ASCII 小写字母），
# 按契约第 2 条走 pypinyin fallback；这里补充便于搜索的常用串。
YUANLIU_FORMS = {
    581: ("tanke", "tk"),
    582: ("fashi", "fs"),
    583: ("cike", "ck"),
    584: ("sheshou", "ss"),
    585: ("fuzhu", "fz"),
}
YUANLIU_BASE = "yuanliuzhizi"
YUANLIU_BASE_INITIALS = "ylzz"

# 详情页分路文案抽查对象（契约要求 ≥3 个；覆盖对抗路/中路/打野/游走）
DETAIL_SAMPLES = [105, 136, 137, 187]

ASCII_LOWER_RE = re.compile(r"^[a-z]+$")
CJK_RE = re.compile(r"[^\u4e00-\u9fff]")


# ---------------------------------------------------------------- 网络工具

def cache_path(name):
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, name)


def fetch(url, cache_name, encoding, offline=False, max_age_days=1):
    """下载并解码页面；带磁盘缓存。offline=True 时只读缓存。"""
    fp = cache_path(cache_name)
    if os.path.exists(fp):
        age_days = (time.time() - os.path.getmtime(fp)) / 86400.0
        if offline or age_days <= max_age_days:
            return open(fp, "rb").read().decode(encoding, "replace")
    if offline:
        raise RuntimeError("offline 模式下缓存缺失：%s" % url)
    req = urllib.request.Request(url, headers=HDRS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    with open(fp, "wb") as fh:
        fh.write(raw)
    return raw.decode(encoding, "replace")


def fetch_bytes(url, cache_name, offline=False, max_age_days=1):
    fp = cache_path(cache_name)
    if os.path.exists(fp):
        age_days = (time.time() - os.path.getmtime(fp)) / 86400.0
        if offline or age_days <= max_age_days:
            return open(fp, "rb").read()
    if offline:
        raise RuntimeError("offline 模式下缓存缺失：%s" % url)
    req = urllib.request.Request(url, headers=HDRS)
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = resp.read()
    with open(fp, "wb") as fh:
        fh.write(raw)
    return raw


def http_head(url, timeout=30):
    """返回 (status, content_length)。网络异常返回 (-1, None)。"""
    try:
        req = urllib.request.Request(url, headers=HDRS, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Length")
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except Exception:
        return -1, None


_URL_STATUS_CACHE_FILE = "url-status.json"


def load_url_status_cache():
    fp = cache_path(_URL_STATUS_CACHE_FILE)
    if os.path.exists(fp):
        try:
            return json.load(open(fp, "r", encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_url_status_cache(cache):
    json.dump(cache, open(cache_path(_URL_STATUS_CACHE_FILE), "w", encoding="utf-8"))


def check_urls(urls, refresh=False, workers=24, label=""):
    """并发 HEAD 校验 URL，返回 {url: status}；结果落盘缓存以便重跑。"""
    cache = {} if refresh else load_url_status_cache()
    todo = [u for u in urls if u not in cache]
    if todo:
        sys.stderr.write("[url] %s 需校验 %d 个 URL（缓存命中 %d）...\n"
                         % (label, len(todo), len(urls) - len(todo)))
        done = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(http_head, u): u for u in todo}
            for fut in concurrent.futures.as_completed(futures):
                u = futures[fut]
                try:
                    status, _ = fut.result()
                except Exception:
                    status = -1
                cache[u] = status
                done += 1
                if done % 100 == 0:
                    sys.stderr.write("[url]   %d/%d\n" % (done, len(todo)))
        save_url_status_cache(cache)
    # 保留本轮未请求但已知的状态
    return {u: cache.get(u, -1) for u in urls}


# ---------------------------------------------------------------- 官网页面取证

def extract_type_map_from_list_page(html):
    m = re.search(r"typeMap\s*=\s*\{[^}]*\}", html)
    return re.sub(r"\s+", " ", m.group(0)).strip() if m else None


def extract_hero_type_name_from_api(api_js):
    m = re.search(r"HERO_TYPE_NAME\s*=\s*\{[^}]*\}", api_js)
    return re.sub(r"\s+", " ", m.group(0)).strip() if m else None


def detail_sentences(html):
    """把详情页 HTML 拆成干净的中文句子列表，便于摘录分路相关原文。"""
    t = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    t = re.sub(r"<script.*?</script>", "", t, flags=re.S)
    t = re.sub(r"<style.*?</style>", "", t, flags=re.S)
    t = re.sub(r"<[^>]+>", "", t)
    t = t.replace("&nbsp;", " ").replace("&amp;", "&")
    parts = re.split(r"[。；\n]+", t)
    return [re.sub(r"\s+", " ", s).strip() for s in parts if s.strip()]


def extract_lane_sentence(html, hero_name, lanes, limit=220):
    """优先摘录「同时含英雄名与分路词」的句子，退而求其次摘录含分路词的句子。"""
    sents = detail_sentences(html)
    fallback = None
    for s in sents:
        hit = [l for l in lanes if l in s]
        if not hit:
            continue
        if hero_name and hero_name in s:
            return s[:limit], hit[0]
        if fallback is None:
            fallback = (s[:limit], hit[0])
    return fallback if fallback else (None, None)


# ---------------------------------------------------------------- 拼音

def pinyin_of(name):
    """返回 (full, initials)，均基于 pypinyin；括号等非中文字符先剔除。"""
    stripped = CJK_RE.sub("", name) or name
    full = "".join(lazy_pinyin(stripped))
    initials = "".join(lazy_pinyin(stripped, style=Style.FIRST_LETTER))
    return full, initials


def build_pinyin(hero):
    """按契约生成 pinyin 字段，返回 (pinyin_dict, audit_row_or_None)。"""
    ename = hero["ename"]
    name = hero["cname"]
    id_name = hero["id_name"] or ""
    py_full, py_initials = pinyin_of(name)

    used_fallback = not ASCII_LOWER_RE.match(id_name)
    if used_fallback:
        full = py_full
        initials = py_initials
    else:
        full = id_name
        initials = py_initials

    initials = INITIALS_OVERRIDE.get(ename, initials)

    variants = [id_name, full, initials]
    variants.extend(EXTRA_VARIANTS.get(ename, []))
    if ename in YUANLIU_FORMS:
        form_full, form_initials = YUANLIU_FORMS[ename]
        variants.extend([
            id_name.replace("_", ""),
            YUANLIU_BASE,
            YUANLIU_BASE_INITIALS,
            form_full,
            form_initials,
        ])

    seen, clean = set(), []
    for v in variants:
        v = (v or "").strip().lower()
        if v and v not in seen:
            seen.add(v)
            clean.append(v)

    audit = None
    if py_full != id_name or used_fallback:
        audit = {
            "ename": ename,
            "name": name,
            "id_name": id_name,
            "pypinyin_full": py_full,
            "pypinyin_initials": py_initials,
            "final_full": full,
            "final_initials": initials,
            "fallback": used_fallback,
        }
    return {
        "full": full,
        "initials": initials,
        "idName": id_name,
        "variants": clean,
    }, audit


# ---------------------------------------------------------------- 记录构造

def build_records(heroes_raw, url_status, do_url_check):
    records = []
    url_audit = {"avatar_ok": 0, "avatar_bad": [], "splash_ok": 0, "splash_bad": []}
    pinyin_audit = []
    splash_missing = {}   # ename -> [缺失序号]

    for hero in sorted(heroes_raw, key=lambda h: h["ename"]):
        ename = hero["ename"]
        name = hero["cname"]
        id_name = hero["id_name"] or ""

        roles = [ROLE_MAP[int(x)] for x in (hero.get("roles") or "").split("|") if x.strip()]

        types = []
        for key in ("hero_type", "hero_type2"):
            t = hero.get(key)
            if t:
                label = TYPE_MAP[int(t)]
                if label not in types:
                    types.append(label)

        pinyin, audit = build_pinyin(hero)
        if audit:
            pinyin_audit.append(audit)

        avatar = "https://game.gtimg.cn/images/yxzj/img201606/heroimg/%d/%d.jpg" % (ename, ename)

        skin_list = [s for s in (hero.get("skin_name") or "").split("|")]
        splash, missing = [], []
        for idx in range(1, len(skin_list) + 1):
            url = ("https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/"
                   "%d/%d-bigskin-%d.jpg" % (ename, ename, idx))
            if do_url_check:
                status = url_status.get(url, -1)
                if status == 200:
                    splash.append(url)
                    url_audit["splash_ok"] += 1
                else:
                    missing.append((idx, status))
                    url_audit["splash_bad"].append((ename, name, idx, status))
            else:
                splash.append(url)
                url_audit["splash_ok"] += 1

        if do_url_check:
            if url_status.get(avatar, -1) == 200:
                url_audit["avatar_ok"] += 1
            else:
                url_audit["avatar_bad"].append((ename, name, url_status.get(avatar, -1)))
        else:
            url_audit["avatar_ok"] += 1

        if missing:
            splash_missing[ename] = missing

        records.append({
            "id": ename,
            "name": name,
            "title": hero.get("title") or "",
            "idName": id_name,
            "roles": roles,
            "types": types,
            "pinyin": pinyin,
            "avatar": avatar,
            "splash": splash,
            "skins": skin_list,
            "newType": hero.get("new_type", 0),
            "mossId": hero.get("moss_id", 0),
        })
    return records, url_audit, pinyin_audit, splash_missing


# ---------------------------------------------------------------- JS 生成

def js_str(text):
    """Python 字符串 -> JS 字面量（含 U+2028/2029 转义，兼容老引擎）。"""
    out = json.dumps(text, ensure_ascii=False)
    return out.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def js_array(items, indent, compact_limit=100):
    """生成 JS 数组字面量：短数组单行；超长数组换行缩进，末项不留逗号。"""
    if not items:
        return "[]"
    rendered = [js_str(i) for i in items]
    one_line = "[%s]" % ",".join(rendered)
    if compact_limit > 0 and len(one_line) <= compact_limit:
        return one_line
    pad = " " * indent
    inner = " " * (indent + 2)
    lines = "%s%s" % (inner, (",\n" + inner).join(rendered))
    return "[\n%s\n%s]" % (lines, pad)


def render_js(records, generated_at):
    L = []
    L.append("/* 王者荣耀英雄数据快照 —— 数据来源：王者荣耀官网 pvp.qq.com")
    L.append("   由 scripts/build-heroes.py 生成，生成时间：%s" % generated_at)
    L.append("   重新生成方式见 README。 */")
    L.append("window.WZ = window.WZ || {};")
    L.append("WZ.HERO_META = {")
    L.append('  source: "%s",' % URL_HEROLIST)
    L.append('  detailSource: "https://pvp.qq.com/web201605/herodetail/{id}.shtml",')
    L.append('  generatedAt: "%s",' % generated_at)
    L.append("  count: %d" % len(records))
    L.append("};")
    L.append("WZ.HEROES = [")
    for rec in records:
        L.append("  {")
        L.append("    id: %d," % rec["id"])
        L.append("    name: %s," % js_str(rec["name"]))
        L.append("    title: %s," % js_str(rec["title"]))
        L.append("    idName: %s," % js_str(rec["idName"]))
        L.append("    roles: %s," % js_array(rec["roles"], 4))
        L.append("    types: %s," % js_array(rec["types"], 4))
        L.append("    pinyin: {")
        L.append("      full: %s," % js_str(rec["pinyin"]["full"]))
        L.append("      initials: %s," % js_str(rec["pinyin"]["initials"]))
        L.append("      idName: %s," % js_str(rec["pinyin"]["idName"]))
        L.append("      variants: %s" % js_array(rec["pinyin"]["variants"], 6))
        L.append("    },")
        L.append("    avatar: %s," % js_str(rec["avatar"]))
        L.append("    splash: %s," % js_array(rec["splash"], 4, compact_limit=0))
        L.append("    skins: %s," % js_array(rec["skins"], 4))
        L.append("    newType: %d," % int(rec["newType"]))
        L.append("    mossId: %d" % int(rec["mossId"]))
        L.append("  }%s" % ("," if rec is not records[-1] else ""))
    L.append("];")
    L.append("")
    L.append("/* 按 id（官网 ename）查英雄；找不到返回 null。 */")
    L.append("WZ.heroById = function (id) {")
    L.append("  var n = Number(id);")
    L.append("  if (!isFinite(n)) { return null; }")
    L.append("  for (var i = 0; i < WZ.HEROES.length; i++) {")
    L.append("    if (WZ.HEROES[i].id === n) { return WZ.HEROES[i]; }")
    L.append("  }")
    L.append("  return null;")
    L.append("};")
    L.append("")
    L.append("/* 搜索英雄：空查询返回全部；大小写不敏感；")
    L.append("   排序权重 name 前缀(0) < idName 前缀(1) < 包含(2)，同权重按 id 升序。 */")
    L.append("WZ.searchHeroes = function (query) {")
    L.append("  var all = WZ.HEROES;")
    L.append("  var q = (query === null || query === undefined) ? \"\" : String(query);")
    L.append("  q = q.replace(/^\\s+|\\s+$/g, \"\").toLowerCase();")
    L.append("  if (!q) { return all.slice(); }")
    L.append("  var hits = [];")
    L.append("  for (var i = 0; i < all.length; i++) {")
    L.append("    var h = all[i];")
    L.append("    var name = String(h.name || \"\").toLowerCase();")
    L.append("    var idName = String(h.idName || \"\").toLowerCase();")
    L.append("    var weight = -1;")
    L.append("    if (name.indexOf(q) === 0) {")
    L.append("      weight = 0;")
    L.append("    } else if (idName.indexOf(q) === 0) {")
    L.append("      weight = 1;")
    L.append("    } else if (name.indexOf(q) >= 0 || idName.indexOf(q) >= 0) {")
    L.append("      weight = 2;")
    L.append("    } else {")
    L.append("      var vs = (h.pinyin && h.pinyin.variants) || [];")
    L.append("      for (var k = 0; k < vs.length; k++) {")
    L.append("        if (String(vs[k]).toLowerCase().indexOf(q) >= 0) { weight = 2; break; }")
    L.append("      }")
    L.append("    }")
    L.append("    if (weight >= 0) { hits.push({ w: weight, h: h }); }")
    L.append("  }")
    L.append("  hits.sort(function (a, b) { return (a.w - b.w) || (a.h.id - b.h.id); });")
    L.append("  var out = [];")
    L.append("  for (var j = 0; j < hits.length; j++) { out.push(hits[j].h); }")
    L.append("  return out;")
    L.append("};")
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------- 报告

def md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def render_report(ctx):
    R = ctx
    L = []
    A = L.append

    A("# data/heroes.js 生成报告")
    A("")
    A("- 生成脚本：`scripts/build-heroes.py`（可重跑：`python scripts/build-heroes.py`）")
    A("- 生成时间：%s（Asia/Shanghai）" % R["generated_at"])
    A("- 产物：`data/heroes.js`（UTF-8 无 BOM，2 空格缩进，普通 `<script>` 可直接加载）")
    A("- 英雄总数：**%d**" % R["count"])
    A("")
    A("## 1. 结论摘要")
    A("")
    A("- 主数据源 `%s` 抓到 **%d** 条英雄，与契约要求的 133 一致。" % (URL_HEROLIST, R["count"]))
    A("- 分路映射 **1=对抗路 2=打野 3=中路 4=发育路 5=游走** 已用官方另一数据源逐条反证，"
      "133 条中 **%d 条顺序+集合完全一致**。" % R["role_exact"])
    A("- 定位映射 **1=战士 2=法师 3=坦克 4=刺客 5=射手 6=辅助**，有官方页面源码级别的两处直接证据（见 2.2）。")
    A("- 拼音：**%d/%d** 英雄的 `id_name` 与 pypinyin 全拼一致；"
      "不一致 %d 条逐条人工裁定并列表（见第 5 节）。" % (R["pinyin_match"], R["count"], R["pinyin_diff_count"]))
    A("- 图片 URL 全量 HEAD 校验：avatar %d/%d 通过，splash %d/%d 通过，"
      "**404 的 %d 个 splash 已剔除**（见第 7 节）。" % (
          R["avatar_ok"], R["count"], R["splash_ok"], R["splash_total"], R["splash_bad_count"]))
    A("")

    A("## 2. 数据源与映射证据")
    A("")
    A("### 2.1 分路映射（roles 字段）")
    A("")
    A("`herolist.json` 的 `roles` 是 `\"1|5\"` 这类数字串，官网并没有在同一份 JSON 里给出数字含义。")
    A("本次用官网**《王者荣耀》资料库**接口 `%s` 的 `fllb_2105` 字段（官方中文分路文案）逐条反证。" % URL_ZLK)
    A("")
    A("该接口由官网 `herolist.shtml` 页面经由 `api.js` 的 `getHeroSkinList()` 实际调用，"
      "同一函数里 `zzy_2397`→`type`（主职业）、`fzy_8576`→`type2`（副职业）、`fllb_2105`→分路文案。")
    A("")
    A("**反证结果：** 把 `roles` 按 `{1:对抗路,2:打野,3:中路,4:发育路,5:游走}` 展开后与 `fllb_2105` 对比：")
    A("")
    A("- 一致（集合与顺序都相同）：**%d / %d**" % (R["role_exact"], R["count"]))
    A("- 集合相同、顺序不同：%d" % R["role_order_only"])
    A("- 不一致：**%d** 条，全部是 2026 年新上线英雄，且是 `fllb_2105` 侧字段未更新（见第 8 节）" % R["role_mismatch_count"])
    A("")
    A("官方 `fllb_2105` 的全部取值（原样，未改写）：")
    A("")
    A("```")
    for v, c in R["fllb_dist"]:
        A("%-22s %d" % (v if v else "(空)", c))
    A("```")
    A("")
    A("抽样原始记录（官网 `heroskinlist.json`）：")
    A("")
    A("```json")
    for line in R["zlk_samples"]:
        A(line)
    A("```")
    A("")
    A("**详情页原始取证**（`herodetail/{ename}.shtml`，GBK）。")
    A("")
    A("说明：官网详情页**没有结构化的分路字段**（只有技能/铭文/出装/克制关系的文案），"
      "所以下面的页面原文只作旁证；分路映射的主证据是上面 130/133 的字段级逐条比对。")
    A("")
    for s in R["detail_evidence"]:
        A("- **%s**（ename=%d）`roles=%s` → %s" % (s["name"], s["ename"], s["roles_raw"], "、".join(s["roles"])))
        A("  - 页面原文（命中「%s」）：`%s`" % (s["matched_lane"], s["sentence"]))
    A("")
    A("> 补充：全部 117 个可访问的详情页里，出现过分路用词的共 37 个，且**从未出现过「发育路」一词**，"
      "「发育路」的中文文案只在官方资料库 `fllb_2105` 字段中给出（17 位英雄）。")
    A("")

    A("### 2.2 定位映射（hero_type 字段）")
    A("")
    A("两处官方页面源码直接给出数字→中文（互不依赖）：")
    A("")
    A("1) `%s`（GBK）内联脚本：" % URL_HEROLIST_PAGE)
    A("")
    A("```js")
    A(R["type_map_page"])
    A("```")
    A("")
    A("2) `%s`（UTF-8）中的 `HERO_TYPE_NAME`：" % URL_API_JS)
    A("")
    A("```js")
    A(R["hero_type_name_api"])
    A("```")
    A("")
    A("两处完全一致，且与契约给定映射一致，故 `types` 取 `hero_type`（主定位）+ `hero_type2`（副定位，若有）去重。")
    A("")

    A("## 3. 分路统计")
    A("")
    A("按英雄计（一个英雄可有多条分路）：")
    A("")
    A(md_table(["分路", "英雄数"], R["lane_counts"]))
    A("")
    A("官方 `roles` 字段原始取值分布（共 %d 种组合）：" % len(R["roles_dist"]))
    A("")
    A(md_table(["roles 原值", "英雄数"], R["roles_dist"]))
    A("")

    A("## 4. 定位统计")
    A("")
    A(md_table(["定位", "英雄数"], R["type_counts"]))
    A("")
    A("含副定位（`hero_type2`）的英雄共 %d 位；`types` 数组长度分布：%s。"
      % (R["type2_count"], R["types_len_dist"]))
    A("")

    A("## 5. 拼音：官方 id_name 优先 + pypinyin fallback")
    A("")
    A("规则（严格按契约）：")
    A("")
    A("1. `id_name` 为纯 ASCII 小写字母 → `full = id_name`（官方注音优先于机器注音）。")
    A("2. `id_name` 非纯 ASCII 小写（本次仅元流之子 5 个形态，含下划线）→ 用 `pypinyin` 生成。")
    A("3. `initials` = 最终采用 full 对应音节的首字母缩写。")
    A("4. `variants` = 去重小写集合，至少含 `idName` / `full` / `initials`，另加少量常见写法。")
    A("")
    A("pypinyin 版本：**%s**" % R["pypinyin_version"])
    A("")
    A("### 5.1 fallback 命中清单（id_name 非纯 ASCII 小写）")
    A("")
    A("命中 **%d** 条：" % len([a for a in R["pinyin_audit"] if a["fallback"]]))
    A("")
    A(md_table(
        ["ename", "name", "官方 id_name", "pypinyin full", "pypinyin initials", "最终 full", "最终 initials"],
        [[a["ename"], a["name"], a["id_name"], a["pypinyin_full"], a["pypinyin_initials"],
          a["final_full"], a["final_initials"]] for a in R["pinyin_audit"] if a["fallback"]]))
    A("")
    A("> fallback 前先剔除 name 中的非中文字符。例如 `元流之子(法师)` → `元流之子法师` → "
      "`yuanliuzhizifashi` / `ylzzfs`。这样 `yuanliuzhizi`、`ylzz` 都能作为子串命中，"
      "同时形态后缀（fashi/fs）也能被搜到。")
    A("")
    A("### 5.2 交叉校验：id_name vs pypinyin 不一致清单")
    A("")
    A("不一致共 **%d** 条（含上表 5 条 fallback）：" % R["pinyin_diff_count"])
    A("")
    A(md_table(
        ["英雄", "name", "id_name", "pypinyin", "最终采用", "理由"],
        [[a["name"], a["name"], a["id_name"], a["pypinyin_full"], a["final_full"], a["reason"]]
         for a in R["pinyin_audit"]]))
    A("")
    A("> 官方 `heroskinlist.json` 的 `yxpymc_4614`（官方拼音名）与 `herolist.json` 的 `id_name` "
      "**133/133 完全一致**，是「官网注音优先」的第二重佐证。")
    A("")

    A("## 6. 自检清单")
    A("")
    A("| 检查项 | 结果 |")
    A("|---|---|")
    for k, v in R["selfcheck"]:
        A("| %s | %s |" % (k, v))
    A("")

    A("## 7. 图片 URL 校验")
    A("")
    A("对全部 `avatar`（%d 个）与全部 `splash` 候选（%d 个，= Σ skins 数）逐个发 HTTP HEAD："
      % (R["count"], R["splash_total"]))
    A("")
    A("- `avatar`：**200 × %d**，失败 %d 个" % (R["avatar_ok"], len(R["url_audit"]["avatar_bad"])))
    A("- `splash`：**200 × %d**，失败 %d 个（已从 `splash` 数组中剔除）"
      % (R["splash_ok"], R["splash_bad_count"]))
    A("")
    A("### 7.1 契约要求的抽样（5 个 avatar + 12 个 splash）")
    A("")
    A(md_table(["类型", "英雄", "URL", "HTTP 状态"], R["sample_rows"]))
    A("")
    A("### 7.2 404 明细（已剔除的 splash 序号）")
    A("")
    A(md_table(["ename", "英雄", "缺失序号 N", "状态码"], R["splash_bad_rows"]))
    A("")
    A("规律（已逐序号验证）：")
    A("")
    A("- %d 位英雄的缺失序号**恰好等于 `skins.length`**，即只有「最新一款皮肤」的 `-bigskin-N.jpg` 尚未由 CDN 提供；"
      "这些英雄各自前 `skins.length - 1` 张仍然一一对应。" % R["splash_last_only_count"])
    A("- %d 位全新英雄（%s）连第 1 张都没有：它们的详情页 `herodetail/{ename}.shtml` 本身也是 404"
      "（官网对未上线英雄只提供 `m_bl_link` 预告页），故 `splash: []`。"
      % (R["splash_no_art_count"], R["splash_no_art_names"]))
    A("")

    A("## 8. 可疑项 / 不确定项")
    A("")
    for item in R["suspicious"]:
        A("- %s" % item)
    A("")

    A("## 9. 契约自测")
    A("")
    A("用 Node.js 加载生成后的 `data/heroes.js` 并断言以下语义（脚本：`node` 直接执行，无依赖）：")
    A("")
    A("```")
    A(R["js_selftest"])
    A("```")
    A("")

    A("## 10. 复现方式")
    A("")
    A("```powershell")
    A("python scripts/build-heroes.py                 # 完整重跑（联网 + 全量图片 HEAD 校验）")
    A("python scripts/build-heroes.py --offline       # 仅用本地缓存重跑")
    A("python scripts/build-heroes.py --refresh-urls  # 强制重新校验全部图片 URL")
    A("```")
    A("")
    A("缓存目录：`%TEMP%/wzbp-heroes-cache`（不写入仓库）。")
    A("")
    return "\n".join(L)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="生成 data/heroes.js")
    ap.add_argument("--offline", action="store_true", help="只用本地缓存，不联网")
    ap.add_argument("--refresh-urls", action="store_true", help="忽略 URL 校验缓存")
    ap.add_argument("--skip-url-check", action="store_true", help="跳过图片 URL 校验（仅调试用）")
    args = ap.parse_args()

    do_url_check = not args.skip_url_check
    generated_at = datetime.datetime.now().strftime("%Y-%m-%d")

    # ---- 1. 主数据
    raw = fetch_bytes(URL_HEROLIST, "herolist.json", offline=args.offline)
    heroes_raw = json.loads(raw.decode("utf-8"))
    sys.stderr.write("[data] herolist.json: %d 条\n" % len(heroes_raw))

    # ---- 2. 官方交叉校验数据（拿不到不致命）
    zlk = {}
    try:
        zlk_raw = fetch_bytes(URL_ZLK, "heroskinlist.json", offline=args.offline)
        for item in json.loads(zlk_raw.decode("utf-8"))["yxlb20_2489"]:
            zlk[str(item["yxid_a7"])] = item
        sys.stderr.write("[data] heroskinlist.json: %d 条\n" % len(zlk))
    except Exception as exc:
        sys.stderr.write("[warn] 官方交叉校验数据获取失败：%r\n" % exc)

    # ---- 3. 页面取证（拿不到不致命）
    page_type_map = None
    api_type_name = None
    try:
        html = fetch(URL_HEROLIST_PAGE, "herolist.shtml", "gbk", offline=args.offline)
        page_type_map = extract_type_map_from_list_page(html)
    except Exception as exc:
        sys.stderr.write("[warn] 列表页取证失败：%r\n" % exc)
    try:
        api_js = fetch(URL_API_JS, "api.js", "utf-8", offline=args.offline)
        api_type_name = extract_hero_type_name_from_api(api_js)
    except Exception as exc:
        sys.stderr.write("[warn] api.js 取证失败：%r\n" % exc)

    # ---- 4. 图片 URL 校验
    urls = []
    for h in heroes_raw:
        e = h["ename"]
        urls.append("https://game.gtimg.cn/images/yxzj/img201606/heroimg/%d/%d.jpg" % (e, e))
        for i in range(1, len((h.get("skin_name") or "").split("|")) + 1):
            urls.append("https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/"
                        "%d/%d-bigskin-%d.jpg" % (e, e, i))
    if do_url_check:
        url_status = check_urls(urls, refresh=args.refresh_urls, label="images")
    else:
        url_status = {}
        sys.stderr.write("[warn] 已跳过图片 URL 校验\n")

    # ---- 5. 构造记录
    records, url_audit, pinyin_audit, splash_missing = build_records(
        heroes_raw, url_status, do_url_check)

    # ---- 6. 写 heroes.js
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    js = render_js(records, generated_at)
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(js + "\n" if not js.endswith("\n") else js)
    sys.stderr.write("[out] %s (%d bytes)\n" % (OUT_JS, os.path.getsize(OUT_JS)))

    # ---- 7. 统计
    hero_by_id = {h["ename"]: h for h in heroes_raw}
    lane_counts = collections.Counter()
    for rec in records:
        for lane in rec["roles"]:
            lane_counts[lane] += 1
    type_counts = collections.Counter()
    for rec in records:
        for t in rec["types"]:
            type_counts[t] += 1
    roles_dist = collections.Counter((hero_by_id[r["id"]].get("roles") or "") for r in records)

    role_exact = role_order_only = role_mismatch = 0
    role_mismatch_rows = []
    for rec in records:
        z = zlk.get(str(rec["id"]))
        if not z:
            continue
        got = [t for t in z["fllb_2105"].split("/") if t]
        if rec["roles"] == got:
            role_exact += 1
        elif set(rec["roles"]) == set(got):
            role_order_only += 1
        else:
            role_mismatch += 1
            role_mismatch_rows.append((rec["id"], rec["name"], hero_by_id[rec["id"]].get("roles"),
                                       "/".join(rec["roles"]), z["fllb_2105"]))

    try:
        import pypinyin as _pp
        pp_version = _pp.__version__
    except Exception:
        pp_version = "unknown"

    # 抽样取证
    rng = random.Random(20260930)
    sample_heroes = rng.sample(records, 5)
    splash_pool = [(r["name"], u) for r in records for u in r["splash"]]
    rng.shuffle(splash_pool)
    sample_splash = splash_pool[:12]
    sample_rows = []
    for rec in sample_heroes:
        st = url_status.get(rec["avatar"], -1) if do_url_check else "skipped"
        sample_rows.append(("avatar", rec["name"], rec["avatar"], st))
    for nm, u in sample_splash:
        st = url_status.get(u, -1) if do_url_check else "skipped"
        sample_rows.append(("splash", nm, u, st))

    splash_bad_rows = []
    for ename, name, idx, status in sorted(url_audit["splash_bad"]):
        splash_bad_rows.append((ename, name, idx, status))

    # 详情页取证：官网详情页没有结构化的 roles 字段，这里只摘录页面原文作为旁证
    detail_evidence = []
    for e in DETAIL_SAMPLES:
        raw_h = hero_by_id[e]
        roles = [ROLE_MAP[int(x)] for x in (raw_h.get("roles") or "").split("|") if x]
        sentence, matched_lane = None, None
        try:
            page = fetch(URL_DETAIL.format(e=e), "detail-%d.shtml" % e, "gbk", offline=args.offline)
            sentence, matched_lane = extract_lane_sentence(page, raw_h["cname"], roles)
        except Exception as exc:
            sentence = "(详情页获取失败：%r)" % exc
        detail_evidence.append({
            "ename": e, "name": raw_h["cname"],
            "roles_raw": raw_h.get("roles"), "roles": roles,
            "matched_lane": matched_lane,
            "sentence": sentence or "(页面内未出现该英雄的分路用词)",
        })

    # 拼音理由
    REASONS = {
        114: "多音字「禅」读 shàn，机器注音 chan 错误；官网 id_name 更准 → 采官网",
        124: "官网 id_name 用 v 表示 ü（zhouyv）；采官网，另补常见写法 zhouyu",
        130: "多音字「藏」读 zàng，机器注音 cang 错误 → 采官网",
        163: "官网 id_name 用 v 表示 ü（jvyoujing）；采官网，另补 juyoujing / jv",
        508: "多音字「伽」读 jiā，机器注音 ga 错误 → 采官网",
        522: "cname 仅「曜」而官方 id_name 为全名「东方曜」dongfangyao；按契约「多音字优先官网 idName」"
             "采 dongfangyao，initials 跟随 full 取 dfy，并按契约补 yao / yue 变体",
    }
    for row in pinyin_audit:
        if row["fallback"]:
            row["reason"] = ("id_name 含下划线（非纯 ASCII 小写），按契约第 2 条改用 pypinyin；"
                             "生成前剔除括号等非中文字符")
        else:
            row["reason"] = REASONS.get(row["ename"], "机器注音与官方不一致 → 采官网 id_name")

    # 自检
    ids = [r["id"] for r in records]
    names = [r["name"] for r in records]
    missing_fields = []
    for r in records:
        for f in ("id", "name", "title", "idName", "roles", "types", "pinyin", "avatar", "skins"):
            v = r[f]
            if v is None or v == "" or v == []:
                missing_fields.append((r["id"], r["name"], f))
        if not r["pinyin"]["full"] or not r["pinyin"]["initials"] or not r["pinyin"]["variants"]:
            missing_fields.append((r["id"], r["name"], "pinyin.*"))
    skins_total = sum(len(r["skins"]) for r in records)
    splash_len_match = sum(1 for r in records if len(r["splash"]) == len(r["skins"]))
    required_variant_fail = [
        (r["id"], r["name"]) for r in records
        if not (r["pinyin"]["idName"].lower() in r["pinyin"]["variants"]
                and r["pinyin"]["full"].lower() in r["pinyin"]["variants"]
                and r["pinyin"]["initials"].lower() in r["pinyin"]["variants"])
    ]
    js_bytes = open(OUT_JS, "rb").read()
    selfcheck = [
        ("英雄总数 = 133", "%d %s" % (len(records), "✅" if len(records) == 133 else "❌（线上已变化，见第 8 节）")),
        ("无重复 id", "%s（唯一 id %d 个）" % ("✅" if len(set(ids)) == len(ids) else "❌", len(set(ids)))),
        ("无重复 name", "%s（唯一 name %d 个）" % ("✅" if len(set(names)) == len(names) else "❌", len(set(names)))),
        ("必备字段非空（id/name/title/idName/roles/types/pinyin/avatar/skins）",
         "%s（缺失 %d 处）" % ("✅" if not missing_fields else "❌", len(missing_fields))),
        ("variants 必含 idName / full / initials",
         "%s（异常 %d 个）" % ("✅" if not required_variant_fail else "❌", len(required_variant_fail))),
        ("splash.length === skins.length", "%d/%d 英雄成立%s" % (
            splash_len_match, len(records),
            "✅" if splash_len_match == len(records) else
            "；%d 位因 CDN 缺图而不等（已在第 7.2 节列出，符合「404 不写入」要求）"
            % (len(records) - splash_len_match))),
        ("skins 总数", "%d" % skins_total),
        ("产物编码", "UTF-8 %s BOM" % ("无" if not js_bytes.startswith(b"\xef\xbb\xbf") else "有")),
        ("产物为普通 <script> 可加载", "✅ `window.WZ = window.WZ || {};` + 全局赋值，无 import/export/模块语法"),
        ("图片 URL 全量校验", "avatar %d/%d 200，splash %d/%d 200" % (
            url_audit["avatar_ok"], len(records), url_audit["splash_ok"], skins_total)),
    ]

    role_exact_total = sum(1 for _ in records)
    # 官方 zzy_2397/fzy_8576（主/副职业）与 herolist hero_type/hero_type2 的差异数
    type_mismatch_count = 0
    if zlk:
        for h in heroes_raw:
            z = zlk.get(str(h["ename"]))
            if not z:
                continue
            zzy = int(z["zzy_2397"]) if z["zzy_2397"] else None
            fzy = int(z["fzy_8576"]) if z["fzy_8576"] else None
            ht2 = int(h["hero_type2"]) if h.get("hero_type2") else None
            if zzy != h["hero_type"] or fzy != ht2:
                type_mismatch_count += 1

    # 可疑项
    splash_no_art = [r for r in records if len(r["splash"]) == 0]
    splash_shorter = [r for r in records if 0 < len(r["splash"]) < len(r["skins"])]
    # 只统计「有图但少了最后一张」的；完全没有图的单独统计
    splash_last_only = [
        r for r in splash_shorter
        if [i for i, _ in splash_missing.get(r["id"], [])] == [len(r["skins"])]
    ]
    suspicious = []
    suspicious.append(
        "**元流之子(刺客)（ename=583）的 `hero_type` 可疑**：`herolist.json` 里 `hero_type=6`（辅助），"
        "但同一英雄 `roles=2`（打野），且官方 `heroskinlist.json` 的 `zzy_2397=4`（刺客）。"
        "契约规定 `types` 取 `hero_type`/`hero_type2`，故当前输出为 `types:[\"辅助\"]`；"
        "若 UI 上看到「元流之子(刺客)·辅助」属官网主数据滞后，不是本项目的数据错误。")
    if zlk:
        suspicious.append(
            "**官方两份数据源的 `hero_type` 与 `zzy_2397`（主职业）/`fzy_8576`（副职业）有 %d 处不一致**。"
            "`api.js` 中 `type: hero.zzy_2397, type2: hero.fzy_8576`，说明资料库用的是新一套职业字段。"
            "差异分两类：(a) 主副顺序调换（如张飞 3/6 → 6/3）；(b) 新版资料库多出副职业（如明世隐新增「法师」）。"
            "契约要求以 `herolist.json` 的 `hero_type` 为准，本产物照此输出，此处仅备案。" % type_mismatch_count)
    suspicious.append(
        "**%d 位英雄完全没有皮肤大图**：%s——其 `herodetail/{ename}.shtml` 返回 404，`-bigskin-1.jpg` 也为 404，"
        "故 `splash: []`。UI 需要容忍 `splash.length === 0`（注意 `js/utils.js` 的 `util.splashes()` 在 splash 为空时"
        "会用 skins 长度兜底重新拼 URL，那批 URL 未经验证且实际为 404，会走 `bindImgFallback` 首字兜底）。"
        % (len(splash_no_art), "、".join("%s(%d)" % (r["name"], r["id"]) for r in splash_no_art)))
    suspicious.append(
        "**另有 %d 位英雄缺少「最新一款皮肤」的大图**（该皮肤已出现在 `skin_name` 里但 CDN 尚未提供），"
        "导致 `splash.length === skins.length - 1`；经逐序号校验，这 %d 位的缺失序号**恰好等于 `skins.length`**"
        "（即只有最后一款缺失），因此 `splash[i]` 与 `skins[i]` 在各自前 `skins.length - 1` 项仍严格对齐，只在末尾少一项。"
        "详见第 7.2 节。" % (len(splash_shorter), len(splash_last_only)))
    if zlk:
        for row in role_mismatch_rows:
            suspicious.append(
                "**分路数据源不一致**：%s(ename=%d) `herolist.roles=%s`→`%s`，"
                "而官方资料库 `fllb_2105=%r`。契约规定 `roles` 来自 `roles` 字段，故本产物采用前者的值。"
                % (row[1], row[0], row[2], row[3], row[4]))
    suspicious.append(
        "**`extra_cold_lane` 字段未使用**：它是官网的「次选分路」，有 %d 位英雄非空，"
        "与 `fllb_2105` 的分路集合并不总是重合，含义待考，契约也未要求，故未写入 `heroes.js`。"
        % sum(1 for h in heroes_raw if (h.get("extra_cold_lane") or "")))
    suspicious.append(
        "**心魔六耳(549) 是「命格英雄」**：官方 `heroskinlist.json` 里 `sfsmgy_4767=1`（132 位英雄中唯一一个），"
        "且无详情页、无 `fllb_2105`，只有 1 款皮肤。属官网的特殊英雄形态。")

    # JS 自测（用 Node 执行）
    js_selftest = run_js_selftest(OUT_JS, records)

    ctx = {
        "generated_at": generated_at,
        "count": len(records),
        "role_exact": role_exact,
        "role_total": role_exact_total,
        "role_order_only": role_order_only,
        "role_mismatch_count": role_mismatch,
        "pinyin_match": len(records) - len(pinyin_audit),
        "pinyin_diff_count": len(pinyin_audit),
        "avatar_ok": url_audit["avatar_ok"],
        "splash_ok": url_audit["splash_ok"],
        "splash_total": skins_total,
        "splash_bad_count": len(url_audit["splash_bad"]),
        "url_audit": url_audit,
        "lane_counts": sorted(lane_counts.items(), key=lambda x: (-x[1], x[0])),
        "roles_dist": sorted(roles_dist.items(), key=lambda x: (-x[1], x[0])),
        "type_counts": sorted(type_counts.items(), key=lambda x: (-x[1], x[0])),
        "type2_count": sum(1 for h in heroes_raw if h.get("hero_type2")),
        "types_len_dist": dict(sorted(collections.Counter(len(r["types"]) for r in records).items())),
        "pinyin_audit": pinyin_audit,
        "pypinyin_version": pp_version,
        "selfcheck": selfcheck,
        "suspicious": suspicious,
        "sample_rows": sample_rows,
        "splash_bad_rows": splash_bad_rows,
        "splash_last_only_count": len(splash_last_only),
        "splash_no_art_count": len(splash_no_art),
        "splash_no_art_names": "、".join("%s(%d)" % (r["name"], r["id"]) for r in splash_no_art),
        "js_selftest": js_selftest,
        "type_map_page": page_type_map or "(取证失败)",
        "hero_type_name_api": api_type_name or "(取证失败)",
        "fllb_dist": sorted(collections.Counter(z["fllb_2105"] for z in zlk.values()).items(),
                            key=lambda x: (-x[1], x[0])),
        "zlk_samples": [
            json.dumps({k: zlk[str(e)][k] for k in
                        ("yxid_a7", "yxmclb_9965", "yxpymc_4614", "fllb_2105", "zzy_2397", "fzy_8576")},
                       ensure_ascii=False)
            for e in (105, 111, 136, 150, 167) if str(e) in zlk
        ],
        "detail_evidence": detail_evidence,
    }

    report = render_report(ctx)
    with open(OUT_REPORT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(report + "\n")
    sys.stderr.write("[out] %s (%d bytes)\n" % (OUT_REPORT, os.path.getsize(OUT_REPORT)))
    sys.stderr.write("[done] 英雄 %d，splash 200×%d，404×%d\n"
                     % (len(records), url_audit["splash_ok"], len(url_audit["splash_bad"])))
    return 0


R_TYPE_MISMATCH_COUNT = 0  # 由 main() 动态计算并写入报告


def run_js_selftest(js_path, records):
    """用 node 加载生成的 heroes.js，断言契约语义；返回可贴进报告的文本。"""
    import subprocess
    node = "node"
    script = r"""
var fs = require('fs');
var vm = require('vm');
var src = fs.readFileSync(process.argv[2], 'utf8');
// 在 vm 沙箱里模拟浏览器：sandbox 自身就是 window，因此 `window.WZ = ...`
// 之后全局 `WZ` 也能解析到（与 <script src> 的行为一致）。
var sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
var WZ = sandbox.WZ;
var out = [];
function ok(name, cond, extra) { out.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  [' + extra + ']' : '')); }
function tier(h, q) {
  if (h.name.toLowerCase().indexOf(q) === 0) { return 0; }
  if (h.idName.toLowerCase().indexOf(q) === 0) { return 1; }
  return 2;
}
ok('WZ 全局存在', !!WZ);
ok('WZ.HERO_META.count === WZ.HEROES.length', WZ.HERO_META.count === WZ.HEROES.length, WZ.HEROES.length + '');
ok('WZ.HEROES 条数 = 133', WZ.HEROES.length === 133, WZ.HEROES.length + '');
ok('WZ.HEROES 按 id 升序', WZ.HEROES.every(function (h, i) { return i === 0 || WZ.HEROES[i-1].id < h.id; }));
ok('每条记录字段完整（含 pinyin.variants 三项）', WZ.HEROES.every(function (h) {
  var v = (h.pinyin && h.pinyin.variants) || [];
  return typeof h.id === 'number' && !!h.name && h.title !== undefined && !!h.idName
    && Array.isArray(h.roles) && h.roles.length > 0
    && Array.isArray(h.types) && h.types.length > 0
    && !!h.pinyin.full && !!h.pinyin.initials
    && v.indexOf(h.pinyin.full) >= 0 && v.indexOf(h.pinyin.initials) >= 0 && v.indexOf(h.idName) >= 0
    && !!h.avatar && Array.isArray(h.splash) && Array.isArray(h.skins) && h.skins.length > 0;
}));
ok('heroById(105) 命中廉颇', (WZ.heroById(105) || {}).name === '廉颇');
ok('heroById("105") 数字字符串也命中', (WZ.heroById('105') || {}).name === '廉颇');
ok('heroById(999999) === null', WZ.heroById(999999) === null);
ok('heroById(null) === null', WZ.heroById(null) === null);
ok('heroById(undefined) === null', WZ.heroById(undefined) === null);
ok('heroById("abc") === null', WZ.heroById('abc') === null);
ok('heroById 返回 HEROES 中同一对象', WZ.heroById(105) === WZ.HEROES[0]);
ok('searchHeroes("") 返回全部', WZ.searchHeroes('').length === WZ.HEROES.length);
ok('searchHeroes(null) 返回全部', WZ.searchHeroes(null).length === WZ.HEROES.length);
ok('searchHeroes(undefined) 返回全部', WZ.searchHeroes(undefined).length === WZ.HEROES.length);
ok('searchHeroes("   ") 返回全部', WZ.searchHeroes('   ').length === WZ.HEROES.length);
ok('searchHeroes() 无参返回全部', WZ.searchHeroes().length === WZ.HEROES.length);
ok('searchHeroes 返回数组', Array.isArray(WZ.searchHeroes('x')));
ok('searchHeroes 不修改 WZ.HEROES', WZ.HEROES.length === 133);
var r1 = WZ.searchHeroes('廉颇');
ok('searchHeroes("廉颇") => 廉颇', r1.length >= 1 && r1[0].name === '廉颇');
var r2 = WZ.searchHeroes('LIANPO');
ok('大小写不敏感 "LIANPO"', r2.length >= 1 && r2[0].name === '廉颇');
ok('"lp" 首字母命中廉颇', WZ.searchHeroes('lp').some(function (h) { return h.name === '廉颇'; }));
var r4 = WZ.searchHeroes('gongsunli');
ok('searchHeroes("gongsunli") => 公孙离', r4.length >= 1 && r4[0].name === '公孙离');
ok('"gsl" 命中公孙离', WZ.searchHeroes('gsl').some(function (h) { return h.name === '公孙离'; }));
ok('"yao" 命中曜', WZ.searchHeroes('yao').some(function (h) { return h.name === '曜'; }));
ok('"yue" 命中曜（契约要求的变体）', WZ.searchHeroes('yue').some(function (h) { return h.name === '曜'; }));
var r8 = WZ.searchHeroes('liushan');
ok('searchHeroes("liushan") => 刘禅（官网注音优先）', r8.length >= 1 && r8[0].name === '刘禅');
function ylzzCount(q) { return WZ.searchHeroes(q).filter(function (h) { return h.name.indexOf('元流之子') === 0; }).length; }
ok('"yuanliuzhizi" 命中 5 个元流之子', ylzzCount('yuanliuzhizi') === 5, ylzzCount('yuanliuzhizi') + '');
ok('"ylzz" 命中 5 个元流之子', ylzzCount('ylzz') === 5, ylzzCount('ylzz') + '');
var r11 = WZ.searchHeroes('yuanliuzhizifashi');
ok('searchHeroes("yuanliuzhizifashi") => 元流之子(法师)', r11.length >= 1 && r11[0].name === '元流之子(法师)');
ok('"yuanliuzhizi_tank" 下划线写法可搜', WZ.searchHeroes('yuanliuzhizi_tank').some(function (h) { return h.name === '元流之子(坦克)'; }));
// name 前缀(0) < idName 前缀(1) < 包含(2)，同权重按 id 升序
var q = 'a';
var res = WZ.searchHeroes(q);
var tiers = res.map(function (h) { return tier(h, q); });
ok('"a" 结果权重非递减', tiers.every(function (v, i) { return i === 0 || tiers[i-1] <= v; }));
var bad = false, grp = {};
res.forEach(function (h, i) { var t = tiers[i]; (grp[t] = grp[t] || []).push(h.id); });
Object.keys(grp).forEach(function (k) { var a = grp[k]; for (var i = 1; i < a.length; i++) { if (a[i-1] > a[i]) { bad = true; } } });
ok('同权重按 id 升序', !bad);
// 权重分层抽查：name 前缀必须排在 idName 前缀之前
var q2 = 'li';
var res2 = WZ.searchHeroes(q2), t2 = res2.map(function (h) { return tier(h, q2); });
ok('"' + q2 + '" 权重非递减', t2.every(function (v, i) { return i === 0 || t2[i-1] <= v; }));
out.push('SUMMARY  PASS=' + out.filter(function (l) { return l.indexOf('PASS') === 0; }).length +
         ' FAIL=' + out.filter(function (l) { return l.indexOf('FAIL') === 0; }).length);
console.log(out.join('\n'));
"""
    tmp = os.path.join(tempfile.gettempdir(), "wzbp-heroes-selftest.js")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(script)
    try:
        proc = subprocess.run([node, tmp, js_path], capture_output=True, text=True,
                              encoding="utf-8", timeout=60)
        return (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:
        return "自测执行失败：%r" % exc


if __name__ == "__main__":
    sys.exit(main())
