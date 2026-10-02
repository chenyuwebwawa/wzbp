/* ============================================================
   wzbp · 服务端英雄白名单（契约 §7）
   ------------------------------------------------------------
   启动时读 data/heroes.js，用正则提取 `id` → `name` 映射。
   **绝不执行该文件**：data/heroes.js 是浏览器脚本（挂 window.WZ），
   执行它会把浏览器全局带进服务端，且将来被改动时风险不可控。

   提取失败（文件缺失 / 生成格式变了）→ 降级为「不校验英雄存在性」，
   并由 api.js 在 /api/health 里标 heroList:false。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const HERO_FILE = path.join(__dirname, '..', 'data', 'heroes.js');
/* 少于这个数量视为「格式变了」，宁可降级也不要用半截白名单误杀正常英雄 */
const MIN_EXPECTED = 50;

/* 主正则：{ id: 105, name: "廉颇", ... }（当前生成器格式：id 与 name 相邻） */
const RE_PAIR = /id\s*:\s*(\d{1,6})\s*,\s*name\s*:\s*"((?:[^"\\]|\\.)*)"/g;
/* 兜底正则：id 与 name 之间还隔着别的字段（最多 400 字符，不跨条目） */
const RE_PAIR_LOOSE = /id\s*:\s*(\d{1,6})\b[\s\S]{0,400}?name\s*:\s*"((?:[^"\\]|\\.)*)"/g;

const map = new Map();
let ok = false;
let note = '';

function unescapeJson(raw) {
  return String(raw)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n');
}

function collect(src, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const id = Number(m[1]);
    const name = unescapeJson(m[2]).trim();
    if (Number.isInteger(id) && id > 0 && name) out.push([id, name]);
  }
  return out;
}

/* 读取 + 提取；返回是否成功（幂等，可重复调用） */
function load() {
  map.clear();
  ok = false;

  let src = '';
  try {
    src = fs.readFileSync(HERO_FILE, 'utf8');
  } catch (e) {
    note = `读不到 ${HERO_FILE}（${e.code || e.message}）`;
    return false;
  }

  let pairs = collect(src, RE_PAIR);
  if (pairs.length < MIN_EXPECTED) {
    const loose = collect(src, RE_PAIR_LOOSE);
    if (loose.length > pairs.length) pairs = loose;
  }

  for (let i = 0; i < pairs.length; i++) {
    if (!map.has(pairs[i][0])) map.set(pairs[i][0], pairs[i][1]);
  }

  if (map.size >= MIN_EXPECTED) {
    ok = true;
    note = `已加载 ${map.size} 个英雄`;
  } else {
    note = `只提取到 ${map.size} 个英雄（< ${MIN_EXPECTED}），视为格式变化，降级为不校验英雄`;
  }
  return ok;
}

/* 该 id 是否是合法英雄。降级（提取失败）时一律返回 true，
   这样调用方即使忘了看 ok 也不会把所有操作都拒掉。 */
function has(id) {
  if (!ok) return true;
  return map.has(Number(id));
}

/* 名字；没有就返回空串（由调用方决定兜底文案） */
function nameOf(id) {
  return map.get(Number(id)) || '';
}

load();

module.exports = {
  HERO_FILE,
  load,
  has,
  nameOf,
  get ok() { return ok; },
  get count() { return map.size; },
  get note() { return note; },
  /* 调试/自检用 */
  entries() { return Array.from(map.entries()); }
};
