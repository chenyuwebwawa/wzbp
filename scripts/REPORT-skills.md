# REPORT-skills.md —— `data/skills.js`（英雄被动与技能）生成报告

- 生成脚本：`scripts/build-skills.py`（可重跑，纯标准库，无第三方依赖）
- 生成时间：2026-09-30
- 产物：`data/skills.js` —— 237,530 字节，1,352 行，UTF-8 无 BOM，LF 换行
- 覆盖：**133 / 133 位英雄，失败 0 个**；共 **407 条主动技能**（被动另计，共 540 段文案）

---

## 1. 数据源与编码（实测确认，不是猜的）

| 用途 | URL | 编码 | 验证方式 |
| --- | --- | --- | --- |
| 英雄列表 | `https://pvp.qq.com/web201605/js/herolist.json` | **UTF-8**（无 BOM） | `raw.decode('utf-8')` 成功、`json.loads` 成功；用 gbk 解码会得到 `鍏冩祦涔嬪瓙` 这类乱码但仍"解码成功"，**必须按 UTF-8 解** |
| 英雄详情 | `https://pvp.qq.com/web201605/herodetail/{ename}.shtml` | **GBK** | 页面含 `<meta charset="gbk">`；`raw.decode('utf-8')` 直接 `UnicodeDecodeError`，`decode('gbk')` 得到正常中文 |
| 详情页（新英雄回退） | `https://pvp.qq.com/web201605/herodetail/{id_name}.shtml` | GBK | 见 §1.1 |

### 1.1 重要发现：16 位英雄的 `{ename}.shtml` 是 404，必须用 `id_name`

`herodetail/{ename}.shtml` 对以下 16 位英雄返回 **HTTP 404**（这些是 2023 年后上线的新英雄，官网只发布了 `id_name` 路径的页面）：

> 王维(138)、孙权(151)、蚩奼(172)、大禹(188)、大司命(517)、敖隐(519)、卢雅那(547)、心魔六耳(549)、空空儿(550)、影(558)、少司缘(577)、元流之子(坦克)(581)、元流之子(法师)(582)、元流之子(刺客)(583)、元流之子(射手)(584)、元流之子(辅助)(585)

改用 `herodetail/{id_name}.shtml`（如 `herodetail/shaosiyuan.shtml`）后 **16/16 全部抓到真实技能文案**，因此本次交付覆盖率是 133/133，而不是 117/133。脚本内已固化为「先 `ename`，404 就回退 `id_name`」的逻辑（`fetch()` 对 403/404/410 不重试，直接回退）。

> 注意：`SKILL_META.source` 仍按契约字面量写 `https://pvp.qq.com/web201605/herodetail/{id}.shtml`；上表回退路径只影响抓取过程，不影响输出结构。

---

## 2. 页面结构证据（先人工看页面，再写解析器）

先抓了 `105 廉颇 / 106 小乔 / 509 盾山 / 585 元流之子(辅助)` 的原始字节存盘、用 GBK 解码后人工阅读。技能区真实结构如下（廉颇，原文照抄）：

```html
<div class="skill ls fl">
  <h3 class="tlt fn"><i class="tb2 icon fl"></i>技能介绍</h3>
  <div class="skill-info l info">
    <ul class="skill-u1">
      <li class="curr"><img src="//game.gtimg.cn/images/yxzj/img201606/heroimg/105/10500.png" alt="" /></li>
      <li><img src=".../10510.png" alt="" /></li>
      <li><img src=".../10520.png" alt="" /></li>
      <li><img src=".../10530.png" alt="" /></li>
      <li class="no5" data-img=".../10540.png"><img src="###" alt="" /></li>   <!-- 4 技能槽，多数英雄为空 -->
    </ul>
    <div class="skill-show">
      <div class="show-list" style="display:block;">        <!-- 第 1 块 = 被动 -->
        <p class="skill-name"><b>勇士之魂</b><span>冷却值：0</span><span>消耗：0</span></p>
        <p class="skill-desc">被动：廉颇释放技能过程中会处于霸体状态。……</p>
      </div>
      <div class="show-list">
        <p class="skill-name"><b>爆裂冲撞</b><span>冷却值：9</span><span>消耗：0</span></p>
        <p class="skill-desc">廉颇向指定方向发起冲锋，……</p>
      </div>
      <div class="show-list"> …技能2… </div>
      <div class="show-list"> …技能3… </div>
      <div class="show-list">   <!-- 第 5 块：125 位英雄在此处是空占位，需丢弃 -->
        <p class="skill-name"><b></b><span>冷却值：</span><span>消耗：</span></p>
        <p class="skill-desc"></p>
      </div>
    </div>
  </div>
</div>
```

**实际依赖的选择器（与建议中的 `.skill-list` / `.skill-u1 li` 不同，以真实页面为准）：**

- 技能容器：`div.skill-show` 下的 `div.show-list`（**不是** `.skill-list`；`.skill-u1` 只放图标槽位，里面没有文字）
- 技能名：`p.skill-name > b`
- 冷却：`p.skill-name > span` 中形如 `冷却值：9` 的那个（同层还有 `消耗：0`，本产物未收录消耗）
- 描述：`p.skill-desc`
- 被动：**位置约定**——第一个非空 `show-list` 就是被动（廉颇 `勇士之魂`、盾山 `天地化盾`、元歌 `秘术·操控` 均在第 1 块），其余按顺序为技能 1..n。已用全量 133 页验证该约定成立（无一处把主动技能排在最前）。

`<br>` 是真实存在的（少司缘被动/技能 2 的原文里就有 `<br>`），解析时替换为空格，避免两句话被黏在一起。

---

## 3. 解析方式说明

1. 用标准库 `html.parser.HTMLParser`（`convert_charrefs=True`，`&nbsp;` 等实体会自动解码）遍历文档，按 `div.skill-show` / `div.show-list` 的 div 深度层级切块，不依赖第三方库（`lxml`/`bs4` 均不需要）。
2. 每块内分别收集：`b` 标签文本（技能名）、`span` 文本（取 `冷却值：X` → `X`）、`skill-desc` 文本。
3. 丢弃名字与描述都为空的块（即上面那个空占位块）。
4. 第一个保留块 → `passive`；其余按顺序 → `skills[0..n]`，`key` 依次为 `"1"`、`"2"`…（字符串）。
5. 文案清洗 `clean_text()`：`<br>`→空格 → 兜底去任何残留标签 → `html.unescape` → `\xa0`/`\u3000`/零宽字符 → 空白折叠为单空格 → 去首尾空白。**不做任何改写、截断、补全。**
6. `name`（英雄名）取 `herolist.json` 的 `cname`，与同目录 `heroes.js` 的 `name` 完全一致；另外用页面面包屑 `<label>廉颇</label><span class="hidden">105</span>` 交叉校验（133/133 页面都取到了 label，仅 1 处不一致，见 §7）。

---

## 4. 抓取与限速

- 并发 **5**（`--workers` 可调，脚本硬上限 6），任务要求的 4~6 区间内。
- 失败重试 **2** 次（指数退避 1.5s/3.0s）；**403/404/410 不重试**，直接走 `id_name` 回退，避免无意义地打官网。
- 每次请求后有 0.15~0.30s 随机礼貌间隔。
- 原始字节缓存到系统临时目录 `%TEMP%\wzbp-skills-cache`（**不写进仓库**，避免污染工作区）；重复运行默认走缓存，`--refresh` 才重新联网。

---

## 5. 契约符合性自检（全部通过）

| 自检项 | 结果 | 证据 |
| --- | --- | --- |
| 覆盖率（目标 133） | **133 / 133** | build 输出 `included=133, failed=0`；`Object.keys(WZ.SKILLS).length === 133` |
| 失败清单 | **空** | `failures = {}`；无任何英雄被省略 |
| 每条都有 name / passive{name,desc} | 133/133 | node 校验 `emptyName=0, emptyDesc=0, problems=[]` |
| 每条都有 3 个 skills | 125 个英雄 = 3 条；8 个英雄 = 4 条（官网原文如此，见 §7） | 直方图 `{"3":125,"4":8}`，合计 407 条 |
| desc 无 `<` `>` `&nbsp;` `&amp;` `&#…;` 残留 | **0 残留** | 逐行正则扫描 `html residue lines: 0`；node 对每段 desc 再扫一遍，`problems=[]` |
| desc 无换行/连续空格未折叠 | 0 处 | node 校验 `[\r\n\t]|  ` 命中数 0 |
| cooldown 缺失数 | **0**（407/407 都有） | `missingCooldown=0` |
| `<script>` 可直接加载 | 通过 | node `vm` 里把 `window` 当全局对象执行整个文件（等价浏览器行为）→ `WZ` 正常生成；文件内无 `import/export/require`、无 `fetch/XHR` |
| `WZ.SKILLS["105"]` 与 `WZ.SKILLS[105]` 都取得到 | 通过 | `WZ.SKILLS[105] === WZ.SKILLS['105']` → `true`；键全部为字符串 |
| `WZ.skillsById` 签名 | 通过 | `skillsById('105') === skillsById(105)` → 同一个对象；`skillsById(999999/null/undefined)` → `null` |
| UTF-8 无 BOM / 2 空格缩进 / 无 CRLF | 通过 | `BOM=False`、`has CRLF=False`、结构缩进 2 空格、技能对象单行 |
| 无 STUB / 占位数据 | 通过 | 文件内 `STUB`=False、`占位`=False（原 STUB 文件已被整体覆盖） |
| 与并行产物 `data/heroes.js` 的 id / 名字一致性 | 通过 | heroes.js 133 id ⊂ skills.js 133 id，`missingSkillForHero=[]`、`skillWithoutHero=[]`、`nameMismatch=[]` |

失败清单（明确写出）：

```
（无）——没有任何英雄因为抓取失败或结构异常被省略。
```

---

## 6. 抽查对照：5 个英雄逐条比对官网原文

抽查方法：**另写一套纯正则的独立提取脚本**（不复用 `build-skills.py` 的解析器），直接从缓存下来的**官网原始 GBK 页面字节**里按 `show-list / skill-name / skill-desc` 抠文本，再用 node 加载生成好的 `data/skills.js`，把两者逐条比对（技能名全等、desc 全等、冷却值全等）。

| 英雄 | 页面 URL | 被动 | 技能1 | 技能2 | 技能3 | 技能4 | 逐条一致 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 廉颇(105) | `herodetail/105.shtml` | 勇士之魂 ✓ | 爆裂冲撞 ✓ | 熔岩重击 ✓ | 天崩地裂 ✓ | — | **YES** |
| 小乔(106) | `herodetail/106.shtml` | 治愈微笑 ✓ | 绽放之舞 ✓ | 甜蜜恋风 ✓ | 星华缭乱 ✓ | — | **YES** |
| 盾山(509) | `herodetail/509.shtml` | 天地化盾 ✓ | 一夫当关 ✓ | 万夫莫开 ✓ | 不动如山 ✓ | 困守成规 ✓ | **YES** |
| 少司缘(577) | `herodetail/shaosiyuan.shtml` | 吟行 ✓ | 两同心 ✓ | 怨离别 ✓ | 因缘际会 ✓ | — | **YES** |
| 敖隐(519) | `herodetail/aoyin.shtml` | 隐介藏形 ✓ | 薄日掌火 ✓ | 擎天司雨 ✓ | 踏罡驾风 ✓ | 穷乎玄间 ✓ | **YES** |

逐条的 name/desc/cooldown 全等（脚本输出为 20 行 `OK`，无一 `DIFF`）。下面贴出「官网原文 → 我们的输出」的对照样本。

### 6.1 廉颇 技能1（官网原文 HTML）

```html
<div class="show-list">
  <p class="skill-name"><b>爆裂冲撞</b><span>冷却值：9</span><span>消耗：0</span></p>
  <p class="skill-desc">廉颇向指定方向发起冲锋，对敌人造成150/170/190/210/230/250（+65%物理攻击）点物理伤害并将其击飞0.5秒。 被动：第三次普攻为直拳重击，对敌人造成额外200/260/320/380/440/500（+15%物理加成）点物理伤害。</p>
</div>
```

`data/skills.js` 对应行：

```js
{ "key": "1", "name": "爆裂冲撞", "desc": "廉颇向指定方向发起冲锋，对敌人造成150/170/190/210/230/250（+65%物理攻击）点物理伤害并将其击飞0.5秒。 被动：第三次普攻为直拳重击，对敌人造成额外200/260/320/380/440/500（+15%物理加成）点物理伤害。", "cooldown": "9" }
```

### 6.2 少司缘 被动（官网原文含 `<br>`，验证清洗规则）

```html
<div class="show-list" style="display:block;">
  <p class="skill-name"><b>吟行</b><span>冷却值：7.5</span><span>消耗：0</span></p>
  <p class="skill-desc">少司缘每7.5秒~6秒(随英雄等级成长)强化下次普攻：荡秋千至敌人身前造成150~300(+100%物理攻击)(+35%法术攻击)法术伤害和击退，并借力向后跳跃。<br>当友方英雄受到"良缘赐福"(满生命时不触发金币奖励，主动对生命50%以上友方施放时金币奖励减半)，或敌方英雄受到"冤缘化解"时，少司缘达成业绩获得额外20金币奖励，并缩短强化普攻25%~50%的准备时间。</p>
</div>
```

`data/skills.js` 输出（`<br>` → 空格，无标签残留）：

```js
"passive": { "name": "吟行", "desc": "少司缘每7.5秒~6秒(随英雄等级成长)强化下次普攻：荡秋千至敌人身前造成150~300(+100%物理攻击)(+35%法术攻击)法术伤害和击退，并借力向后跳跃。 当友方英雄受到\"良缘赐福\"(满生命时不触发金币奖励，主动对生命50%以上友方施放时金币奖励减半)，或敌方英雄受到\"冤缘化解\"时，少司缘达成业绩获得额外20金币奖励，并缩短强化普攻25%~50%的准备时间。" }
```

---

## 7. 已知偏差与不确定项（请 Lead 过目）

1. **8 位英雄有 4 个主动技能**，官网原文就是 4 个，契约里写的 key 只到 `"3"`。为了不丢真实数据，这 8 位输出了 `"1"`~`"4"`：
   元歌(125)、兰陵王(153)、女娲(179)、干将莫邪(182)、大乔(191)、李信(507)、盾山(509)、敖隐(519)。
   其余 125 位严格是 `"1"`~`"3"`。若前端按固定 3 个槽位渲染，请用 `slice(0,3)` 或循环渲染。
2. **`passive` 不带 `cooldown` 字段**（按契约只放 `name`/`desc`）。但官网给 9 位英雄的被动也标了「冷却值」：项羽(135) 90、王维(138) 5~4、橘右京(163) 5、杨玉环(176) 3、苍(177) 4、大禹(188) 90、苏烈(194) 120、瑶(505) 60、少司缘(577) 7.5。这些值**没有**写进产物，如果需要可以再加。
3. **契约示例里的冷却值形如 `"9/8.4/7.8/7.2/6.6/6"`，与官网实际不符**：官网对不少技能只给单个数值（廉颇 1 技能就是「冷却值：9」，2 技能才是 6 级数值「11/10.4/…」）。按「不许编造」原则，全部照抄官网原值，**没有做任何等级换算**。
4. **ename 177 的名字不一致**：`herolist.json` 里是「苍」，详情页面包屑与技能正文里仍是旧名「成吉思汗」（例：被动描述首句「被动：成吉思汗穿越草丛时增加40%移速」）。产物里英雄 `name` 取 herolist 的「苍」（与 `heroes.js` 保持一致），技能文案取自页面原文，因此正文会出现「成吉思汗」字样。**这是官网自身的改名遗留**，不是抓取错误。
5. **`SKILL_META.source` 是契约字面量** `…/herodetail/{id}.shtml`，但 §1.1 那 16 位英雄实际抓的是 `{id_name}.shtml`。元数据字段本身无法表达这个差异，特此书面记录。
6. 少量官网文案自身有笔误（例：少司缘技能 2「…减速25/30/35/40/45/50%。，相互贴近时…」多了一个句号），**按原文保留**，未做校对式修改。
7. 页面上没有的技能信息（技能加点、消耗、铭文、出装等）**一律没有抓**，产物只有契约要求的字段。

---

## 8. 复现方式

```powershell
# 全量抓取并写入 data/skills.js（首次会联网，之后默认读 %TEMP% 缓存）
python scripts/build-skills.py

# 只体检不写文件；顺带输出统计 JSON
python scripts/build-skills.py --no-write --summary-json "$env:TEMP\summary.json"

# 忽略缓存重新联网抓取（约 149 次请求：133 页 + 16 次 id_name 回退）
python scripts/build-skills.py --refresh

# 并发可调（默认 5，脚本上限 6）
python scripts/build-skills.py --workers 4
```

产物结构（与契约一致）：

```js
window.WZ = window.WZ || {};
WZ.SKILL_META = { "source": "...herodetail/{id}.shtml", "generatedAt": "2026-09-30", "heroCount": 133 };
WZ.SKILLS = { "105": { "ename": 105, "name": "廉颇",
  "passive": { "name": "勇士之魂", "desc": "被动：…" },
  "skills": [ { "key": "1", "name": "爆裂冲撞", "desc": "…", "cooldown": "9" }, … ] }, … };
WZ.skillsById = function (id) { … };   // 缺失返回 null
```
