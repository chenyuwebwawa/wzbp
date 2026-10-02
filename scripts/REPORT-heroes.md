# data/heroes.js 生成报告

- 生成脚本：`scripts/build-heroes.py`（可重跑：`python scripts/build-heroes.py`）
- 生成时间：2026-09-30（Asia/Shanghai）
- 产物：`data/heroes.js`（UTF-8 无 BOM，2 空格缩进，普通 `<script>` 可直接加载）
- 英雄总数：**133**

## 1. 结论摘要

- 主数据源 `https://pvp.qq.com/web201605/js/herolist.json` 抓到 **133** 条英雄，与契约要求的 133 一致。
- 分路映射 **1=对抗路 2=打野 3=中路 4=发育路 5=游走** 已用官方另一数据源逐条反证，133 条中 **130 条顺序+集合完全一致**。
- 定位映射 **1=战士 2=法师 3=坦克 4=刺客 5=射手 6=辅助**，有官方页面源码级别的两处直接证据（见 2.2）。
- 拼音：**122/133** 英雄的 `id_name` 与 pypinyin 全拼一致；不一致 11 条逐条人工裁定并列表（见第 5 节）。
- 图片 URL 全量 HEAD 校验：avatar 133/133 通过，splash 847/862 通过，**404 的 15 个 splash 已剔除**（见第 7 节）。

## 2. 数据源与映射证据

### 2.1 分路映射（roles 字段）

`herolist.json` 的 `roles` 是 `"1|5"` 这类数字串，官网并没有在同一份 JSON 里给出数字含义。
本次用官网**《王者荣耀》资料库**接口 `https://pvp.qq.com/zlkdatasys/heroskinlist.json` 的 `fllb_2105` 字段（官方中文分路文案）逐条反证。

该接口由官网 `herolist.shtml` 页面经由 `api.js` 的 `getHeroSkinList()` 实际调用，同一函数里 `zzy_2397`→`type`（主职业）、`fzy_8576`→`type2`（副职业）、`fllb_2105`→分路文案。

**反证结果：** 把 `roles` 按 `{1:对抗路,2:打野,3:中路,4:发育路,5:游走}` 展开后与 `fllb_2105` 对比：

- 一致（集合与顺序都相同）：**130 / 133**
- 集合相同、顺序不同：0
- 不一致：**3** 条，全部是 2026 年新上线英雄，且是 `fllb_2105` 侧字段未更新（见第 8 节）

官方 `fllb_2105` 的全部取值（原样，未改写）：

```
打野                     20
中路                     19
游走                     19
发育路                    17
对抗路                    14
对抗路/打野                 14
中路/游走                  5
打野/对抗路                 5
对抗路/游走                 3
中路/对抗路                 2
发育路/打野                 2
游走/对抗路                 2
(空)                    1
中路/对抗路/打野              1
中路/打野                  1
中路/游走/打野               1
对抗路/游走/打野              1
射手                     1
打野/中路                  1
打野/发育路                 1
打野/对抗路/游走              1
法师                     1
游走/中路                  1
```

抽样原始记录（官网 `heroskinlist.json`）：

```json
{"yxid_a7": "105", "yxmclb_9965": "廉颇", "yxpymc_4614": "lianpo", "fllb_2105": "对抗路/游走", "zzy_2397": "3", "fzy_8576": ""}
{"yxid_a7": "111", "yxmclb_9965": "孙尚香", "yxpymc_4614": "sunshangxiang", "fllb_2105": "发育路", "zzy_2397": "5", "fzy_8576": ""}
{"yxid_a7": "136", "yxmclb_9965": "武则天", "yxpymc_4614": "wuzetian", "fllb_2105": "中路", "zzy_2397": "2", "fzy_8576": ""}
{"yxid_a7": "150", "yxmclb_9965": "韩信", "yxpymc_4614": "hanxin", "fllb_2105": "打野", "zzy_2397": "4", "fzy_8576": ""}
{"yxid_a7": "167", "yxmclb_9965": "孙悟空", "yxpymc_4614": "sunwukong", "fllb_2105": "打野", "zzy_2397": "4", "fzy_8576": ""}
```

**详情页原始取证**（`herodetail/{ename}.shtml`，GBK）。

说明：官网详情页**没有结构化的分路字段**（只有技能/铭文/出装/克制关系的文案），所以下面的页面原文只作旁证；分路映射的主证据是上面 130/133 的字段级逐条比对。

- **廉颇**（ename=105）`roles=1|5` → 对抗路、游走
  - 页面原文（命中「对抗路」）：`若走对抗路则携带百穿铭文：异变、鹰眼、隐匿`
- **武则天**（ename=136）`roles=3` → 中路
  - 页面原文（命中「中路」）：`Tips：圣杯能为武则天带来足够的续航，让其可以一直守护中路并利用大招支援边路，发挥其优势能力`
- **司马懿**（ename=137）`roles=2|3` → 打野、中路
  - 页面原文（命中「打野」）：`Tips：司马懿利用被动可以洞悉对手位置并且大招也能超越距离发起突袭，综合下来说司马懿非常适合打野位置`
- **东皇太一**（ename=187）`roles=5|1` → 游走、对抗路
  - 页面原文（命中「游走」）：`Tips：东皇太一的玩法是游走和大招以血还血，这套铭文可以在初期为东皇太一增加移速、生命值、恢复能力，可以提升初期游走和gank能力，中后期至少可以大到一个核心`

> 补充：全部 117 个可访问的详情页里，出现过分路用词的共 37 个，且**从未出现过「发育路」一词**，「发育路」的中文文案只在官方资料库 `fllb_2105` 字段中给出（17 位英雄）。

### 2.2 定位映射（hero_type 字段）

两处官方页面源码直接给出数字→中文（互不依赖）：

1) `https://pvp.qq.com/web201605/herolist.shtml`（GBK）内联脚本：

```js
typeMap = { 3: '坦克', 1: '战士', 2: '法师', 4: '刺客', 5: '射手', 6: '辅助', 10: '限免', 11: '新手' }
```

2) `https://game.gtimg.cn/images/js/pvpcommon/api.js`（UTF-8）中的 `HERO_TYPE_NAME`：

```js
HERO_TYPE_NAME = { 1: '战士', 2: '法师', 3: '坦克', 4: '刺客', 5: '射手', 6: '辅助' }
```

两处完全一致，且与契约给定映射一致，故 `types` 取 `hero_type`（主定位）+ `hero_type2`（副定位，若有）去重。

## 3. 分路统计

按英雄计（一个英雄可有多条分路）：

| 分路 | 英雄数 |
|---|---|
| 打野 | 50 |
| 对抗路 | 44 |
| 游走 | 34 |
| 中路 | 31 |
| 发育路 | 20 |

官方 `roles` 字段原始取值分布（共 20 种组合）：

| roles 原值 | 英雄数 |
|---|---|
| 2 | 21 |
| 5 | 20 |
| 3 | 19 |
| 4 | 17 |
| 1 | 14 |
| 1|2 | 14 |
| 2|1 | 6 |
| 3|5 | 5 |
| 1|5 | 3 |
| 3|1 | 2 |
| 4|2 | 2 |
| 5|1 | 2 |
| 1|5|2 | 1 |
| 2|1|5 | 1 |
| 2|3 | 1 |
| 2|4 | 1 |
| 3|1|2 | 1 |
| 3|2 | 1 |
| 3|5|2 | 1 |
| 5|3 | 1 |

## 4. 定位统计

| 定位 | 英雄数 |
|---|---|
| 法师 | 44 |
| 战士 | 42 |
| 坦克 | 30 |
| 刺客 | 24 |
| 辅助 | 23 |
| 射手 | 21 |

含副定位（`hero_type2`）的英雄共 51 位；`types` 数组长度分布：{1: 82, 2: 51}。

## 5. 拼音：官方 id_name 优先 + pypinyin fallback

规则（严格按契约）：

1. `id_name` 为纯 ASCII 小写字母 → `full = id_name`（官方注音优先于机器注音）。
2. `id_name` 非纯 ASCII 小写（本次仅元流之子 5 个形态，含下划线）→ 用 `pypinyin` 生成。
3. `initials` = 最终采用 full 对应音节的首字母缩写。
4. `variants` = 去重小写集合，至少含 `idName` / `full` / `initials`，另加少量常见写法。

pypinyin 版本：**0.55.0**

### 5.1 fallback 命中清单（id_name 非纯 ASCII 小写）

命中 **5** 条：

| ename | name | 官方 id_name | pypinyin full | pypinyin initials | 最终 full | 最终 initials |
|---|---|---|---|---|---|---|
| 581 | 元流之子(坦克) | yuanliuzhizi_tank | yuanliuzhizitanke | ylzztk | yuanliuzhizitanke | ylzztk |
| 582 | 元流之子(法师) | yuanliuzhizi_magic | yuanliuzhizifashi | ylzzfs | yuanliuzhizifashi | ylzzfs |
| 583 | 元流之子(刺客) | yuanliuzhizi_assassin | yuanliuzhizicike | ylzzck | yuanliuzhizicike | ylzzck |
| 584 | 元流之子(射手) | yuanliuzhizi_archer | yuanliuzhizisheshou | ylzzss | yuanliuzhizisheshou | ylzzss |
| 585 | 元流之子(辅助) | yuanliuzhizi_support | yuanliuzhizifuzhu | ylzzfz | yuanliuzhizifuzhu | ylzzfz |

> fallback 前先剔除 name 中的非中文字符。例如 `元流之子(法师)` → `元流之子法师` → `yuanliuzhizifashi` / `ylzzfs`。这样 `yuanliuzhizi`、`ylzz` 都能作为子串命中，同时形态后缀（fashi/fs）也能被搜到。

### 5.2 交叉校验：id_name vs pypinyin 不一致清单

不一致共 **11** 条（含上表 5 条 fallback）：

| 英雄 | name | id_name | pypinyin | 最终采用 | 理由 |
|---|---|---|---|---|---|
| 刘禅 | 刘禅 | liushan | liuchan | liushan | 多音字「禅」读 shàn，机器注音 chan 错误；官网 id_name 更准 → 采官网 |
| 周瑜 | 周瑜 | zhouyv | zhouyu | zhouyv | 官网 id_name 用 v 表示 ü（zhouyv）；采官网，另补常见写法 zhouyu |
| 宫本武藏 | 宫本武藏 | gongbenwuzang | gongbenwucang | gongbenwuzang | 多音字「藏」读 zàng，机器注音 cang 错误 → 采官网 |
| 橘右京 | 橘右京 | jvyoujing | juyoujing | jvyoujing | 官网 id_name 用 v 表示 ü（jvyoujing）；采官网，另补 juyoujing / jv |
| 伽罗 | 伽罗 | jialuo | galuo | jialuo | 多音字「伽」读 jiā，机器注音 ga 错误 → 采官网 |
| 曜 | 曜 | dongfangyao | yao | dongfangyao | cname 仅「曜」而官方 id_name 为全名「东方曜」dongfangyao；按契约「多音字优先官网 idName」采 dongfangyao，initials 跟随 full 取 dfy，并按契约补 yao / yue 变体 |
| 元流之子(坦克) | 元流之子(坦克) | yuanliuzhizi_tank | yuanliuzhizitanke | yuanliuzhizitanke | id_name 含下划线（非纯 ASCII 小写），按契约第 2 条改用 pypinyin；生成前剔除括号等非中文字符 |
| 元流之子(法师) | 元流之子(法师) | yuanliuzhizi_magic | yuanliuzhizifashi | yuanliuzhizifashi | id_name 含下划线（非纯 ASCII 小写），按契约第 2 条改用 pypinyin；生成前剔除括号等非中文字符 |
| 元流之子(刺客) | 元流之子(刺客) | yuanliuzhizi_assassin | yuanliuzhizicike | yuanliuzhizicike | id_name 含下划线（非纯 ASCII 小写），按契约第 2 条改用 pypinyin；生成前剔除括号等非中文字符 |
| 元流之子(射手) | 元流之子(射手) | yuanliuzhizi_archer | yuanliuzhizisheshou | yuanliuzhizisheshou | id_name 含下划线（非纯 ASCII 小写），按契约第 2 条改用 pypinyin；生成前剔除括号等非中文字符 |
| 元流之子(辅助) | 元流之子(辅助) | yuanliuzhizi_support | yuanliuzhizifuzhu | yuanliuzhizifuzhu | id_name 含下划线（非纯 ASCII 小写），按契约第 2 条改用 pypinyin；生成前剔除括号等非中文字符 |

> 官方 `heroskinlist.json` 的 `yxpymc_4614`（官方拼音名）与 `herolist.json` 的 `id_name` **133/133 完全一致**，是「官网注音优先」的第二重佐证。

## 6. 自检清单

| 检查项 | 结果 |
|---|---|
| 英雄总数 = 133 | 133 ✅ |
| 无重复 id | ✅（唯一 id 133 个） |
| 无重复 name | ✅（唯一 name 133 个） |
| 必备字段非空（id/name/title/idName/roles/types/pinyin/avatar/skins） | ✅（缺失 0 处） |
| variants 必含 idName / full / initials | ✅（异常 0 个） |
| splash.length === skins.length | 118/133 英雄成立；15 位因 CDN 缺图而不等（已在第 7.2 节列出，符合「404 不写入」要求） |
| skins 总数 | 862 |
| 产物编码 | UTF-8 无 BOM |
| 产物为普通 <script> 可加载 | ✅ `window.WZ = window.WZ || {};` + 全局赋值，无 import/export/模块语法 |
| 图片 URL 全量校验 | avatar 133/133 200，splash 847/862 200 |

## 7. 图片 URL 校验

对全部 `avatar`（133 个）与全部 `splash` 候选（862 个，= Σ skins 数）逐个发 HTTP HEAD：

- `avatar`：**200 × 133**，失败 0 个
- `splash`：**200 × 847**，失败 15 个（已从 `splash` 数组中剔除）

### 7.1 契约要求的抽样（5 个 avatar + 12 个 splash）

| 类型 | 英雄 | URL | HTTP 状态 |
|---|---|---|---|
| avatar | 赵怀真 | https://game.gtimg.cn/images/yxzj/img201606/heroimg/544/544.jpg | 200 |
| avatar | 曜 | https://game.gtimg.cn/images/yxzj/img201606/heroimg/522/522.jpg | 200 |
| avatar | 刘备 | https://game.gtimg.cn/images/yxzj/img201606/heroimg/170/170.jpg | 200 |
| avatar | 苏烈 | https://game.gtimg.cn/images/yxzj/img201606/heroimg/194/194.jpg | 200 |
| avatar | 元流之子(坦克) | https://game.gtimg.cn/images/yxzj/img201606/heroimg/581/581.jpg | 200 |
| splash | 盘古 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/529/529-bigskin-1.jpg | 200 |
| splash | 韩信 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/150/150-bigskin-9.jpg | 200 |
| splash | 西施 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/523/523-bigskin-6.jpg | 200 |
| splash | 芈月 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/121/121-bigskin-7.jpg | 200 |
| splash | 桑启 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/534/534-bigskin-6.jpg | 200 |
| splash | 周瑜 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/124/124-bigskin-3.jpg | 200 |
| splash | 朵莉亚 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/159/159-bigskin-2.jpg | 200 |
| splash | 姜子牙 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/148/148-bigskin-3.jpg | 200 |
| splash | 狂铁 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/503/503-bigskin-1.jpg | 200 |
| splash | 老夫子 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/139/139-bigskin-5.jpg | 200 |
| splash | 庄周 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/113/113-bigskin-4.jpg | 200 |
| splash | 莱西奥 | https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/545/545-bigskin-3.jpg | 200 |

### 7.2 404 明细（已剔除的 splash 序号）

| ename | 英雄 | 缺失序号 N | 状态码 |
|---|---|---|---|
| 112 | 鲁班七号 | 13 | 404 |
| 117 | 钟无艳 | 9 | 404 |
| 124 | 周瑜 | 9 | 404 |
| 135 | 项羽 | 10 | 404 |
| 138 | 王维 | 1 | 404 |
| 142 | 安琪拉 | 10 | 404 |
| 152 | 王昭君 | 10 | 404 |
| 167 | 孙悟空 | 12 | 404 |
| 174 | 虞姬 | 11 | 404 |
| 184 | 蔡文姬 | 10 | 404 |
| 188 | 大禹 | 1 | 404 |
| 189 | 鬼谷子 | 8 | 404 |
| 527 | 蒙恬 | 5 | 404 |
| 529 | 盘古 | 7 | 404 |
| 547 | 卢雅那 | 1 | 404 |

规律（已逐序号验证）：

- 12 位英雄的缺失序号**恰好等于 `skins.length`**，即只有「最新一款皮肤」的 `-bigskin-N.jpg` 尚未由 CDN 提供；这些英雄各自前 `skins.length - 1` 张仍然一一对应。
- 3 位全新英雄（王维(138)、大禹(188)、卢雅那(547)）连第 1 张都没有：它们的详情页 `herodetail/{ename}.shtml` 本身也是 404（官网对未上线英雄只提供 `m_bl_link` 预告页），故 `splash: []`。

## 8. 可疑项 / 不确定项

- **元流之子(刺客)（ename=583）的 `hero_type` 可疑**：`herolist.json` 里 `hero_type=6`（辅助），但同一英雄 `roles=2`（打野），且官方 `heroskinlist.json` 的 `zzy_2397=4`（刺客）。契约规定 `types` 取 `hero_type`/`hero_type2`，故当前输出为 `types:["辅助"]`；若 UI 上看到「元流之子(刺客)·辅助」属官网主数据滞后，不是本项目的数据错误。
- **官方两份数据源的 `hero_type` 与 `zzy_2397`（主职业）/`fzy_8576`（副职业）有 11 处不一致**。`api.js` 中 `type: hero.zzy_2397, type2: hero.fzy_8576`，说明资料库用的是新一套职业字段。差异分两类：(a) 主副顺序调换（如张飞 3/6 → 6/3）；(b) 新版资料库多出副职业（如明世隐新增「法师」）。契约要求以 `herolist.json` 的 `hero_type` 为准，本产物照此输出，此处仅备案。
- **3 位英雄完全没有皮肤大图**：王维(138)、大禹(188)、卢雅那(547)——其 `herodetail/{ename}.shtml` 返回 404，`-bigskin-1.jpg` 也为 404，故 `splash: []`。UI 需要容忍 `splash.length === 0`（注意 `js/utils.js` 的 `util.splashes()` 在 splash 为空时会用 skins 长度兜底重新拼 URL，那批 URL 未经验证且实际为 404，会走 `bindImgFallback` 首字兜底）。
- **另有 12 位英雄缺少「最新一款皮肤」的大图**（该皮肤已出现在 `skin_name` 里但 CDN 尚未提供），导致 `splash.length === skins.length - 1`；经逐序号校验，这 12 位的缺失序号**恰好等于 `skins.length`**（即只有最后一款缺失），因此 `splash[i]` 与 `skins[i]` 在各自前 `skins.length - 1` 项仍严格对齐，只在末尾少一项。详见第 7.2 节。
- **分路数据源不一致**：王维(ename=138) `herolist.roles=2`→`打野`，而官方资料库 `fllb_2105='法师'`。契约规定 `roles` 来自 `roles` 字段，故本产物采用前者的值。
- **分路数据源不一致**：卢雅那(ename=547) `herolist.roles=5`→`游走`，而官方资料库 `fllb_2105='射手'`。契约规定 `roles` 来自 `roles` 字段，故本产物采用前者的值。
- **分路数据源不一致**：心魔六耳(ename=549) `herolist.roles=2|1`→`打野/对抗路`，而官方资料库 `fllb_2105=''`。契约规定 `roles` 来自 `roles` 字段，故本产物采用前者的值。
- **`extra_cold_lane` 字段未使用**：它是官网的「次选分路」，有 15 位英雄非空，与 `fllb_2105` 的分路集合并不总是重合，含义待考，契约也未要求，故未写入 `heroes.js`。
- **心魔六耳(549) 是「命格英雄」**：官方 `heroskinlist.json` 里 `sfsmgy_4767=1`（132 位英雄中唯一一个），且无详情页、无 `fllb_2105`，只有 1 款皮肤。属官网的特殊英雄形态。

## 9. 契约自测

用 Node.js 加载生成后的 `data/heroes.js` 并断言以下语义（脚本：`node` 直接执行，无依赖）：

```
PASS  WZ 全局存在
PASS  WZ.HERO_META.count === WZ.HEROES.length  [133]
PASS  WZ.HEROES 条数 = 133  [133]
PASS  WZ.HEROES 按 id 升序
PASS  每条记录字段完整（含 pinyin.variants 三项）
PASS  heroById(105) 命中廉颇
PASS  heroById("105") 数字字符串也命中
PASS  heroById(999999) === null
PASS  heroById(null) === null
PASS  heroById(undefined) === null
PASS  heroById("abc") === null
PASS  heroById 返回 HEROES 中同一对象
PASS  searchHeroes("") 返回全部
PASS  searchHeroes(null) 返回全部
PASS  searchHeroes(undefined) 返回全部
PASS  searchHeroes("   ") 返回全部
PASS  searchHeroes() 无参返回全部
PASS  searchHeroes 返回数组
PASS  searchHeroes 不修改 WZ.HEROES
PASS  searchHeroes("廉颇") => 廉颇
PASS  大小写不敏感 "LIANPO"
PASS  "lp" 首字母命中廉颇
PASS  searchHeroes("gongsunli") => 公孙离
PASS  "gsl" 命中公孙离
PASS  "yao" 命中曜
PASS  "yue" 命中曜（契约要求的变体）
PASS  searchHeroes("liushan") => 刘禅（官网注音优先）
PASS  "yuanliuzhizi" 命中 5 个元流之子  [5]
PASS  "ylzz" 命中 5 个元流之子  [5]
PASS  searchHeroes("yuanliuzhizifashi") => 元流之子(法师)
PASS  "yuanliuzhizi_tank" 下划线写法可搜
PASS  "a" 结果权重非递减
PASS  同权重按 id 升序
PASS  "li" 权重非递减
SUMMARY  PASS=34 FAIL=0

```

## 10. 复现方式

```powershell
python scripts/build-heroes.py                 # 完整重跑（联网 + 全量图片 HEAD 校验）
python scripts/build-heroes.py --offline       # 仅用本地缓存重跑
python scripts/build-heroes.py --refresh-urls  # 强制重新校验全部图片 URL
```

缓存目录：`%TEMP%/wzbp-heroes-cache`（不写入仓库）。

