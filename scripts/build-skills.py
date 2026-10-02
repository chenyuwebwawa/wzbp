#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从王者荣耀官网英雄详情页抓取技能数据，生成 data/skills.js。

数据来源
--------
* 英雄列表: https://pvp.qq.com/web201605/js/herolist.json           (UTF-8)
* 英雄详情: https://pvp.qq.com/web201605/herodetail/{ename}.shtml   (GBK)

页面结构（2026-09 实测，详见 scripts/REPORT-skills.md）
-----------------------------------------------------
    <div class="skill-info">
      <ul class="skill-u1"> ... 图标槽位 ... </ul>
      <div class="skill-show">
        <div class="show-list" style="display:block;">      <- 第 1 块 = 被动
          <p class="skill-name"><b>勇士之魂</b><span>冷却值：0</span><span>消耗：0</span></p>
          <p class="skill-desc">被动：廉颇释放技能……</p>
        </div>
        <div class="show-list"> ... 技能1 ... </div>
        <div class="show-list"> ... 技能2 ... </div>
        <div class="show-list"> ... 技能3 ... </div>
        <div class="show-list"> ... 少数英雄有第 4 个技能 / 多数为空占位块 ... </div>
      </div>
    </div>

解析器用标准库 html.parser 走一遍文档，按 .skill-show / .show-list 的层级收集文本，
不依赖第三方库；输出普通 <script> 可加载的 JS（file:// 下不能 fetch，故不用 JSON）。

用法
----
    python scripts/build-skills.py                # 抓取并写 data/skills.js
    python scripts/build-skills.py --no-write     # 只体检，不写文件
    python scripts/build-skills.py --refresh      # 忽略本地缓存，重新抓取
    python scripts/build-skills.py --workers 4    # 调整并发（默认 5，上限 6）
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import random
import re
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# 控制台按 UTF-8 输出，避免 Windows GBK 控制台报 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JS = os.path.join(ROOT, "data", "skills.js")
CACHE_DIR = os.path.join(tempfile.gettempdir(), "wzbp-skills-cache")

HERO_LIST_URL = "https://pvp.qq.com/web201605/js/herolist.json"
DETAIL_URL = "https://pvp.qq.com/web201605/herodetail/{id}.shtml"
# 2023 年后上线的新英雄（大司命/敖隐/少司缘/影/元流之子…）在官网上没有 {ename}.shtml，
# 但同一路径下用 id_name（如 dasiming.shtml）可以访问，实测 14 位英雄全部可用。
DETAIL_URL_BY_NAME = "https://pvp.qq.com/web201605/herodetail/{idname}.shtml"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": "https://pvp.qq.com/", "Accept-Language": "zh-CN,zh;q=0.9"}

DEFAULT_WORKERS = 5      # 任务要求并发 4~6
MAX_WORKERS = 6
RETRIES = 2              # 任务要求失败重试 2 次
POLITE_DELAY = 0.15      # 每个 worker 每次请求后的礼貌间隔（秒）


# --------------------------------------------------------------------------
# 网络
# --------------------------------------------------------------------------
def fetch(url: str, encoding: str, refresh: bool = False) -> tuple[str, bool]:
    """抓取 url；带磁盘缓存（系统临时目录，不污染仓库）。返回 (text, from_cache)。

    404/403 属于"这个地址不存在"，不重试（触发上面的 id_name 回退逻辑）；
    其它网络错误按任务要求重试 2 次。
    """
    name = re.sub(r"[^0-9A-Za-z_.-]", "_", url.split("//", 1)[-1])
    cache_path = os.path.join(CACHE_DIR, name)
    if not refresh and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        with open(cache_path, "rb") as fh:
            return fh.read().decode(encoding, errors="replace"), True

    last_err: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=30) as resp:
                raw = resp.read()
            text = raw.decode(encoding, errors="replace")
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(cache_path, "wb") as fh:
                fh.write(raw)
            time.sleep(POLITE_DELAY + random.random() * 0.15)
            return text, False
        except HTTPError as exc:
            if exc.code in (403, 404, 410):
                raise RuntimeError(f"HTTP {exc.code} {url}") from exc
            last_err = exc
        except (URLError, TimeoutError, OSError) as exc:
            last_err = exc
        if attempt < RETRIES:
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"fetch failed after {RETRIES + 1} attempts: {url}: {last_err}")


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------
def clean_text(raw: str) -> str:
    """清洗：去标签痕迹/实体/换行，压缩连续空白为单个空格。"""
    if not raw:
        return ""
    s = raw.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    s = s.replace("\xa0", " ").replace("\u3000", " ").replace("\u200b", "")
    s = re.sub(r"<[^>]*>", " ", s)     # 兜底：任何残留标签
    s = re.sub(r"\s+", " ", s)
    return s.strip()


class SkillPageParser(HTMLParser):
    """只依赖标准库，按 .skill-show > .show-list > p.skill-name/p.skill-desc 收集。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict] = []
        self.div_depth = 0
        self.show_depth = 0
        self.cur: dict | None = None
        self.mode: str | None = None
        self.in_b = False
        self.in_span = False
        self.name_b: list[str] = []
        self.name_plain: list[str] = []
        self.desc_buf: list[str] = []
        self.span_buf: list[str] = []
        self.spans: list[str] = []

    @staticmethod
    def _classes(attrs) -> list[str]:
        for key, val in attrs:
            if key == "class" and val:
                return val.split()
        return []

    def _feed(self, text: str) -> None:
        if self.cur is None:
            return
        if self.mode == "desc":
            self.desc_buf.append(text)
        elif self.mode == "name":
            if self.in_span:
                self.span_buf.append(text)
            elif self.in_b:
                self.name_b.append(text)
                self.name_plain.append(text)
            else:
                self.name_plain.append(text)

    def handle_data(self, data):
        self._feed(data)

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self._feed(" ")
            return
        classes = self._classes(attrs)
        if tag == "div":
            self.div_depth += 1
            if "skill-show" in classes and not self.show_depth:
                self.show_depth = self.div_depth
            elif self.show_depth and "show-list" in classes:
                self.cur = {"name": "", "desc": "", "cooldown": None}
                self.blocks.append(self.cur)
                self.mode = None
            return
        if self.cur is None:
            return
        if tag == "p":
            if "skill-name" in classes:
                self.mode = "name"
            elif "skill-desc" in classes:
                self.mode = "desc"
            return
        if self.mode == "name" and tag == "b":
            self.in_b = True
        elif self.mode == "name" and tag == "span":
            self.in_span = True
            self.span_buf = []

    def handle_endtag(self, tag):
        if tag == "br":
            return
        if tag == "div":
            if self.show_depth and self.div_depth == self.show_depth:
                self.show_depth = 0
                self.cur = None
                self.mode = None
            elif self.show_depth and "show-list":
                self.cur = None
                self.mode = None
            self.div_depth = max(0, self.div_depth - 1)
            return
        if self.cur is None:
            return
        if tag == "b":
            self.in_b = False
        elif tag == "span":
            self.in_span = False
            text = clean_text("".join(self.span_buf))
            if text:
                self.spans.append(text)
            self.span_buf = []
        elif tag == "p":
            if self.mode == "name":
                self.cur["name"] = clean_text("".join(self.name_b) or "".join(self.name_plain))
                for text in self.spans:
                    text = text.strip()
                    if text.startswith("冷却值") or text.startswith("冷却"):
                        value = re.sub(r"^冷却值?\s*[:：]?\s*", "", text).strip()
                        self.cur["cooldown"] = value or None
                        break
                self.spans = []
            elif self.mode == "desc":
                self.cur["desc"] = clean_text("".join(self.desc_buf))
            self.mode = None
            self.name_b, self.name_plain, self.desc_buf, self.span_buf = [], [], [], []
            self.in_b = self.in_span = False

    def close(self):  # noqa: D102
        super().close()


PAGE_NAME_RE = re.compile(r"<label>(.*?)</label>\s*<span class=\"hidden\">\s*\d+\s*</span>", re.S)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)


def parse_hero(ename: int, html_text: str) -> dict:
    """解析一个详情页 -> {passive, skills, pageName, pageTitle, blockCount, anomalies}"""
    parser = SkillPageParser()
    parser.feed(html_text)
    parser.close()

    blocks = [b for b in parser.blocks if b["name"] or b["desc"]]
    anomalies: list[str] = []
    if parser.blocks and len(blocks) != len(parser.blocks):
        anomalies.append("empty_placeholder_blocks=%d" % (len(parser.blocks) - len(blocks)))

    passive = None
    actives: list[dict] = []
    if blocks:
        first = blocks[0]
        passive = {"name": first["name"], "desc": first["desc"]}
        # 官网给部分英雄的被动也标了"冷却值"，属正常显示，仅记录不报错
        if first.get("cooldown") not in (None, "", "0"):
            anomalies.append("passive_shows_cooldown=%s" % first["cooldown"])
        for idx, blk in enumerate(blocks[1:], start=1):
            skill = {"key": str(idx), "name": blk["name"], "desc": blk["desc"]}
            if blk.get("cooldown"):
                skill["cooldown"] = blk["cooldown"]
            actives.append(skill)
    if len(actives) != 3:
        anomalies.append("active_skill_count=%d" % len(actives))
    for skill in actives:
        if not skill["name"]:
            anomalies.append("skill%s_empty_name" % skill["key"])
        if not skill["desc"]:
            anomalies.append("skill%s_empty_desc" % skill["key"])
    if passive and not passive["desc"]:
        anomalies.append("passive_empty_desc")

    page_name = ""
    match = PAGE_NAME_RE.search(html_text)
    if match:
        page_name = clean_text(match.group(1))
    title = ""
    match = TITLE_RE.search(html_text)
    if match:
        title = clean_text(match.group(1))

    return {
        "passive": passive,
        "skills": actives,
        "pageName": page_name,
        "pageTitle": title,
        "blockCount": len(parser.blocks),
        "anomalies": anomalies,
    }


def load_hero_list(refresh: bool) -> list[dict]:
    text, cached = fetch(HERO_LIST_URL, "utf-8", refresh)
    data = json.loads(text)
    heroes = [{"ename": int(h["ename"]),
               "cname": h["cname"],
               "id_name": (h.get("id_name") or "").strip()} for h in data]
    print("[herolist] %d heroes (cache=%s, encoding=utf-8)" % (len(heroes), cached))
    return heroes


def crawl(heroes: list[dict], workers: int, refresh: bool):
    results: dict[int, dict] = {}
    failures: dict[int, str] = {}
    stat = {"pages": 0, "cacheHits": 0, "byIdName": 0}

    def work(hero: dict):
        ename = hero["ename"]
        urls = [DETAIL_URL.format(id=ename)]
        if hero["id_name"]:
            urls.append(DETAIL_URL_BY_NAME.format(idname=hero["id_name"]))
        tried: list[str] = []
        for url in urls:
            try:
                text, cached = fetch(url, "gbk", refresh)
            except Exception as exc:
                tried.append("%s -> %s" % (url, exc))
                continue
            parsed = parse_hero(ename, text)
            parsed["url"] = url
            parsed["viaIdName"] = url == urls[-1] and len(urls) > 1
            return ename, parsed, cached
        raise RuntimeError("; ".join(tried) or "no url")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(work, h): h for h in heroes}
        for fut in as_completed(futures):
            hero = futures[fut]
            ename = hero["ename"]
            try:
                _, parsed, cached = fut.result()
            except Exception as exc:  # 抓取失败
                failures[ename] = "fetch_error: %s" % exc
                print("  [FAIL] %s %s -> %s" % (ename, hero["cname"], exc))
                continue
            stat["pages"] += 1
            stat["cacheHits"] += 1 if cached else 0
            stat["byIdName"] += 1 if parsed["viaIdName"] else 0
            if not parsed["blockCount"] or parsed["passive"] is None or not parsed["skills"]:
                failures[ename] = "parse_error: no skill blocks (blockCount=%d)" % parsed["blockCount"]
                print("  [FAIL] %s %s -> no skill blocks" % (ename, hero["cname"]))
                continue
            parsed["ename"] = ename
            parsed["name"] = hero["cname"]
            results[ename] = parsed
            if parsed["anomalies"]:
                print("  [warn] %s %s: %s" % (ename, hero["cname"], "; ".join(parsed["anomalies"])))
    return results, failures, stat


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------
def js_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def build_js(heroes: list[dict], results: dict[int, dict], generated_at: str) -> str:
    lines: list[str] = []
    lines.append("/* 王者荣耀英雄技能数据 —— 数据来源：官网英雄详情页 pvp.qq.com")
    lines.append("   由 scripts/build-skills.py 生成，生成时间：%s */" % generated_at)
    lines.append("window.WZ = window.WZ || {};")
    lines.append("WZ.SKILL_META = {")
    lines.append("  \"source\": \"https://pvp.qq.com/web201605/herodetail/{id}.shtml\",")
    lines.append("  \"generatedAt\": %s," % js_str(generated_at))
    lines.append("  \"heroCount\": %d" % len(results))
    lines.append("};")
    lines.append("WZ.SKILLS = {")
    included = [h for h in heroes if h["ename"] in results]
    for pos, hero in enumerate(included):
        ename = hero["ename"]
        item = results[ename]
        passive = item["passive"]
        lines.append("  %s: {" % js_str(str(ename)))
        lines.append("    \"ename\": %d," % ename)
        lines.append("    \"name\": %s," % js_str(item["name"]))
        lines.append("    \"passive\": { \"name\": %s, \"desc\": %s },"
                     % (js_str(passive["name"]), js_str(passive["desc"])))
        lines.append("    \"skills\": [")
        for i, skill in enumerate(item["skills"]):
            parts = ["\"key\": %s" % js_str(skill["key"]),
                     "\"name\": %s" % js_str(skill["name"]),
                     "\"desc\": %s" % js_str(skill["desc"])]
            if skill.get("cooldown"):
                parts.append("\"cooldown\": %s" % js_str(skill["cooldown"]))
            tail = "," if i + 1 < len(item["skills"]) else ""
            lines.append("      { %s }%s" % (", ".join(parts), tail))
        lines.append("    ]")
        lines.append("  }%s" % ("," if pos + 1 < len(included) else ""))
    lines.append("};")
    lines.append("WZ.skillsById = function (id) {")
    lines.append("  if (id === null || id === undefined) { return null; }")
    lines.append("  return WZ.SKILLS[String(id)] || null;")
    lines.append("};")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="生成 data/skills.js（数据来自 pvp.qq.com 详情页）")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--refresh", action="store_true", help="忽略本地缓存重新抓取")
    ap.add_argument("--no-write", action="store_true", help="只体检，不写 data/skills.js")
    ap.add_argument("--summary-json", default="", help="把体检摘要写到指定 JSON 路径")
    args = ap.parse_args()

    workers = max(1, min(MAX_WORKERS, args.workers))
    heroes = load_hero_list(args.refresh)
    print("[crawl] workers=%d retries=%d" % (workers, RETRIES))
    results, failures, stat = crawl(heroes, workers, args.refresh)

    generated_at = datetime.date.today().isoformat()
    js = build_js(heroes, results, generated_at)

    # ---- 统计与体检 ----
    residue = sum(1 for r in results.values()
                  if re.search(r"[<>]|&nbsp;|&amp;|&#\d+;", r["passive"]["desc"])
                  or any(re.search(r"[<>]|&nbsp;|&amp;|&#\d+;", s["desc"]) for s in r["skills"]))
    no_cd = sum(1 for r in results.values() for s in r["skills"] if not s.get("cooldown"))
    total_skills = sum(len(r["skills"]) for r in results.values())
    extra = {e: len(r["skills"]) for e, r in sorted(results.items()) if len(r["skills"]) != 3}
    name_mismatch = {e: (r["name"], r["pageName"]) for e, r in sorted(results.items())
                     if r["pageName"] and r["pageName"] != r["name"]}
    anomalies = {e: r["anomalies"] for e, r in sorted(results.items()) if r["anomalies"]}
    empty_names = [e for e, r in sorted(results.items())
                   if not r["name"] or not r["passive"]["name"] or not r["passive"]["desc"]
                   or any(not s["name"] or not s["desc"] for s in r["skills"])]

    summary = {
        "generatedAt": generated_at,
        "heroListTotal": len(heroes),
        "included": len(results),
        "failed": len(failures),
        "failures": {str(k): v for k, v in sorted(failures.items())},
        "pagesFetched": stat["pages"],
        "cacheHits": stat["cacheHits"],
        "viaIdNameHeroes": sorted(e for e, r in results.items() if r["viaIdName"]),
        "totalActiveSkills": total_skills,
        "missingCooldown": no_cd,
        "htmlResidueHeroes": residue,
        "incompleteHeroes": empty_names,
        "nonThreeSkillHeroes": {str(k): v for k, v in extra.items()},
        "passiveShowsCooldownHeroes": sorted(e for e, r in results.items()
                                             if any("passive_shows_cooldown" in a for a in r["anomalies"])),
        "pageNameMismatch": {str(k): v for k, v in name_mismatch.items()},
        "anomalies": {str(k): v for k, v in anomalies.items()},
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.summary_json:
        os.makedirs(os.path.dirname(os.path.abspath(args.summary_json)), exist_ok=True)
        with open(args.summary_json, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2)
        print("[summary] -> %s" % args.summary_json)

    if args.no_write:
        print("[dry-run] 未写 %s" % OUT_JS)
        return 0

    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(js)
    print("[write] %s (%d bytes, %d heroes)" % (OUT_JS, len(js.encode("utf-8")), len(results)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
