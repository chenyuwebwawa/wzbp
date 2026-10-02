# html2canvas 1.4.1 本地化与 `file://` 真机实测报告

- 任务：`task-3`（vendor html2canvas 1.4.1 到本地并实测 file:// 跨域出图）
- 执行人：`vendor-html2canvas`
- 日期：2026-09-30（Asia/Shanghai）
- 环境：Windows / PowerShell、Google Chrome **153.0.8010.53**（`--headless=new`）、Node.js **v24.15.0**
- 被测文件：`vendor/html2canvas.min.js`（198,689 字节）

---

## 1. 结论摘要（TL;DR）

| 检查项 | 结果 |
| --- | --- |
| 下载到本地、无 CDN 运行时依赖 | ✅ 通过（双源哈希一致，见 §3） |
| 文件完整性 / 非错误页 / 语法可解析 | ✅ 通过（`node --check` exit 0） |
| `file://` 下能否真正出图 | ✅ 通过（6 个用例全部 resolve，无崩溃） |
| 推荐配置下 canvas 是否被污染 | ✅ 未污染，`toDataURL()` 正常 |
| **任务描述中的原始调用方式** | ⚠️ **静默丢图**：不报错，但跨域图片不出现在导出结果里（详见 §7.1） |

**唯一必须遵守的集成约束：调用 `html2canvas` 时必须传 `useCORS: true`，且不要使用 `allowTaint: true`。**

---

## 2. 校验：下载与完整性

### 2.1 下载命令

```powershell
$out = "C:\Users\Lenoco\Desktop\wzbp\vendor\html2canvas.min.js"
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js" `
  -OutFile $out -TimeoutSec 60 -UseBasicParsing
```

### 2.2 校验命令与输出（原文）

```powershell
> node --check vendor\html2canvas.min.js
node_check_exit=0                      # 无任何输出，语法解析通过
starts_with_comment=True               # 以 /*! html2canvas 1.4.1 ... 版权头开始
contains_html_error_page=False         # 不含 <!DOCTYPE html> / 404: Not Found 等错误页特征
ends_with=(A,e){return Js(A,e=void 0===e?{}:e)}});     # 结尾是完整 UMD 收尾，未被截断
SIZE_BYTES=198689
SHA256=e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb
```

### 2.3 双源交叉校验（关键证据）

| 来源 | 字节数 | SHA-256 |
| --- | --- | --- |
| jsdelivr | 198,689 | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` |
| unpkg | 198,689 | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` |
| **是否一致** | **是** | **`mirrors_match=True`** |

两个独立 CDN 的产物逐字节相同，可排除下载被篡改、被截断或拿到错误版本的可能。文件版权头声明版本为 `1.4.1`（UMD 打包产物不暴露 `html2canvas.version` 属性，实测为 `undefined`）。

---

## 3. 实测方法

测试页 `vendor/.selftest.html`（临时文件，验证后已删除，完整源码见附录 A）在页面内：

1. 用 `<script src="./html2canvas.min.js">` 加载**本地**副本（不涉及任何 CDN 脚本）；
2. 动态构造 3 个 320×400 的导出块，每块内含一张 180×180 的图片：
   - `stage1`：`https://game.gtimg.cn/images/yxzj/img201606/heroimg/105/105.jpg`（**任务指定图片**，`crossOrigin="anonymous"`）；
   - `stage2`：`.../106/106.jpg`（**故意不带** `crossOrigin` 属性，用于验证生产代码是否需要给 `<img>` 加属性）；
   - `stage3`：`data:` URI 图片（**同源内联对照**，用于证明"默认参数路径本身可用"，从而把问题精确定位到跨域处理）；
3. 对每个块调用 `html2canvas`，记录耗时、`canvas` 尺寸、`toDataURL('image/png').length`、以及**图片区域内像素的均值 RGB / 非白像素比例**；
4. 用**独立参考渲染**（把同一 URL 以 `crossOrigin="anonymous"` 重新加载后画到离屏 canvas）算出期望像素，与 html2canvas 结果的图片区域逐项比对，自动判定 `IMAGE_RENDERED` / `IMAGE_MISSING`（均值偏差 < 12 且非白比例差 < 0.12 视为已绘制）。这样"图片是否真的画出来了"不靠肉眼看 dataURL 长度，而是像素级证据。

### 3.1 实际执行的完整命令

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-first-run `
  --user-data-dir="$env:TEMP\h2c-test" --virtual-time-budget=20000 `
  --enable-logging=stderr --v=1 `
  --dump-dom "file:///C:/Users/Lenoco/Desktop/wzbp/vendor/.selftest.html"
```

> 说明（踩坑记录，供他人复现）：
> 1. 任务描述里的基础命令（`--dump-dom` 单独使用）在本环境**不可靠**：Windows 上 `chrome.exe` 是启动器进程，会在真实浏览器进程写输出前就返回（实测 11 ms、输出 0 字节）；且 `--dump-dom` 的 DOM 里包含页面自身 `<script>` 源码，其中的字符串字面量会与"运行结果"混淆。因此本次额外加 `--enable-logging=stderr --v=1`，把页面 `console.log('H2CRES|…')` 的**运行时输出**打到 stderr 作为主要证据，`--dump-dom` 仅作旁证。上面的命令是最终实际执行、且得到下列结果的命令。
> 2. 每次运行使用独立的 `--user-data-dir`，运行结束后只按该唯一目录名精确匹配、结束残留的 headless 进程（未影响用户其它 Chrome 窗口）。

---

## 4. 实测输出（运行时原文，未加工）

页面从 `file://` 协议加载，headless 环境确认：

```
RESULT|env|protocol=file:|origin=file://|headless=true
RESULT|env|html2canvas_typeof=function|version_prop=undefined(UMD exposes none)
RESULT|load|stage1|ok|mode=crossOrigin=anonymous|natural=100x100
RESULT|load|stage2|ok|mode=no-crossOrigin-attr|natural=100x100
RESULT|load|stage3|ok|mode=no-crossOrigin-attr|natural=180x180
RESULT|load_summary|ok=3/3
RESULT|reference|105.jpg|avg=119,81,72|nonWhiteRatio=1.000
RESULT|reference|106.jpg|avg=156,116,145|nonWhiteRatio=0.995
RESULT|reference|dataURI|avg=145,80,133|nonWhiteRatio=1.000
```

六个用例的结果（`dataURLlen` 为 `canvas.toDataURL('image/png')` 的字符长度）：

```
RESULT|A_spec_call_default|opts={"backgroundColor":"#000"}|resolved_ms=214|canvas=320x400|dataURLlen=11166|region[15,63,174x174]|avg=255,255,255|nonWhiteRatio=0.000|verdict=IMAGE_MISSING|avgDelta=164.3|refRatio=1.000|regionRatio=0.000
RESULT|B_useCORS|opts={"backgroundColor":"#000","useCORS":true}|resolved_ms=60|canvas=320x400|dataURLlen=120262|region[15,63,174x174]|avg=119,80,71|nonWhiteRatio=1.000|verdict=IMAGE_RENDERED|avgDelta=0.7|refRatio=1.000|regionRatio=1.000
RESULT|H_foreignObject_useCORS|opts={"backgroundColor":"#000","useCORS":true,"foreignObjectRendering":true}|resolved_ms=60|canvas=320x400|dataURLlen=10454|region[15,63,174x174]|avg=216,218,219|nonWhiteRatio=0.170|verdict=IMAGE_MISSING|avgDelta=127.0|refRatio=1.000|regionRatio=0.170
RESULT|D_noAttr_useCORS|opts={"backgroundColor":"#000","useCORS":true}|resolved_ms=70|canvas=320x400|dataURLlen=120670|region[15,43,174x174]|avg=157,118,147|nonWhiteRatio=0.994|verdict=IMAGE_RENDERED|avgDelta=1.7|refRatio=0.995|regionRatio=0.994
RESULT|E_allowTaint_only|opts={"backgroundColor":"#000","allowTaint":true}|resolved_ms=70|canvas=320x400|dataURLlen=N/A|toDataURL_ERROR=SecurityError: Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.|pixelRead_ERROR=SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.|verdict=NO_PIXELS_READ
RESULT|G_dataURI_default|opts={"backgroundColor":"#000"}|resolved_ms=60|canvas=320x400|dataURLlen=8978|region[15,43,174x174]|avg=143,81,134|nonWhiteRatio=1.000|verdict=IMAGE_RENDERED|avgDelta=1.3|refRatio=1.000|regionRatio=1.000
SELFTEST_DONE|cases_resolved=6|cases_rejected=0
```

整页 wall-clock 约 4.7 秒（含 3 张参考图加载 + 6 次 html2canvas 调用），单次 html2canvas 调用耗时 **60–214 ms**。全程无 `UNCAUGHT` / `UNHANDLED_REJECTION` / `SELFTEST_FATAL`。

---

## 5. 结果解读

| # | 用例 | 配置 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| A | 任务描述的原始调用 | `{backgroundColor:'#000'}` | 正常 resolve，无报错；图片区域 `avg=255,255,255`（纯白背景）、`nonWhiteRatio=0.000`，dataURL 仅 11,166 字符 | ❌ **IMAGE_MISSING（静默丢图）** |
| B | 推荐配置 | `+ useCORS:true` | 图片区域 `avg=119,80,71` vs 参考 `119,81,72`（偏差 0.7），dataURL 120,262 字符 | ✅ **IMAGE_RENDERED** |
| H | foreignObject 路径 | `+ foreignObjectRendering:true` | 图片区域仍以背景色为主（`nonWhiteRatio=0.170`，参考 1.000） | ❌ **IMAGE_MISSING** |
| D | 生产代码不带 `crossorigin` 属性 | `{useCORS:true}`，`<img>` 无 `crossOrigin` | 图片区域 `avg=157,118,147` vs 参考 `156,116,145`（偏差 1.7） | ✅ **IMAGE_RENDERED** |
| E | 只用 `allowTaint` | `{allowTaint:true}` | 图片被绘制，但 canvas 被污染，`toDataURL()` 抛 `SecurityError` | ❌ **导出不可用** |
| G | 同源内联对照组 | `data:` URI + 默认参数 | 图片区域 `avg=143,81,134` vs 参考 `145,80,133`（偏差 1.3） | ✅ **IMAGE_RENDERED** |

### 5.1 核心结论（可执行）

1. **html2canvas 1.4.1 在 `file://` 下确实可用**：本地脚本加载成功、出图成功、`toDataURL()` 成功，无跨域污染问题——**前提是传 `useCORS: true`**。`game.gtimg.cn` 返回 `Access-Control-Allow-Origin: *`，`file://` 页面以 `Origin: null` 发起的 CORS 图片请求被服务器接受（`load_summary|ok=3/3` 即为证据）。
2. **原始调用 `{backgroundColor:'#000'}` 会静默丢图**：用例 A 与 G 构成对照——同样走默认参数，`data:` 内联图（G）画得出来、跨域图（A）画不出来，说明问题精确落在跨域图片处理，而不是 html2canvas 或 `file://` 本身。用例 A 的 `dataURLlen=11166` 与 B 的 `120262` 相差约 11 倍，也是同一结论的旁证。
3. **根因（已在 `vendor/html2canvas.min.js` 的代码中确认）**：资源加载判定条件等价于
   `isSameOrigin(src) || allowTaint !== false || isInline(src) || isSVG(src) || (useCORS && SUPPORT_CORS_IMAGES) || proxy`，
   任一满足才加载该图；全部不满足时**直接跳过、不抛错、不打 warning**。默认 `useCORS=false`、`allowTaint=false`，所以跨域图被静默丢弃。
4. **`allowTaint: true` 不能作为替代**：图片会画上去，但 canvas 立即被污染，导出时 `toDataURL()` 抛 `SecurityError`（见用例 E 原文），截图导出功能直接不可用。
5. **`foreignObjectRendering: true` 在本环境未奏效**：即便同时给了 `useCORS: true`，图片区域仍以背景色为主（用例 H）。因此**不要**把它当作跨域图片的替代方案。
6. **`<img>` 是否带 `crossorigin="anonymous"` 不是必需的**：用例 D 证明，只要 `useCORS: true`，html2canvas 会自行给图片副本设置 `crossOrigin='anonymous'`，未带属性的图片同样能正常绘制。加上该属性属于双保险（可避免"先以非 CORS 方式缓存、后续 CORS 复用时行为受 CDN 响应头影响"的边界情况），推荐但非硬性。

---

## 6. 对站点代码的硬性要求（给导出/截图模块作者）

```js
// ✅ 正确：跨域英雄图片能正常出图
html2canvas(element, { backgroundColor: '#000', useCORS: true }).then(function (canvas) {
  var dataUrl = canvas.toDataURL('image/png');
});

// ❌ 错误 1：跨域图片被静默跳过（不报错，图上没有英雄头像）
html2canvas(element, { backgroundColor: '#000' });

// ❌ 错误 2：canvas 被污染，toDataURL() 抛 SecurityError，导出直接失败
html2canvas(element, { backgroundColor: '#000', allowTaint: true });
```

建议同时：

- 给英雄 `<img>` 加上 `crossorigin="anonymous"`（双保险）；
- 给 `<img>` 挂 `onerror` 兜底（离线或图片 CDN 不可达时，`html2canvas` 会画出空白区域，最好回退成本地占位图或纯色块）；
- 若站点的导出按钮只在图片全部 `complete` 后触发，可避免"导出时图片还没加载完"的空白。

> 说明：本报告的写入范围仅限 `vendor/**` 与 `scripts/REPORT-html2canvas.md`，上述 `js/**` 的改动**由对应负责人实施**，本报告只给出实测依据与要求。

---

## 7. 报错原文与替代方案

### 7.1 用例 A 的"报错"

**没有任何报错**——这正是风险所在。Promise 正常 resolve，`canvas.toDataURL()` 正常返回，只是图片区域是纯背景色：

```
RESULT|A_spec_call_default|opts={"backgroundColor":"#000"}|resolved_ms=214|canvas=320x400|dataURLlen=11166|region[15,63,174x174]|avg=255,255,255|nonWhiteRatio=0.000|verdict=IMAGE_MISSING|avgDelta=164.3|refRatio=1.000|regionRatio=0.000
```

对照参考渲染 `RESULT|reference|105.jpg|avg=119,81,72|nonWhiteRatio=1.000`，可见该区域应是照片内容而非纯白。

### 7.2 用例 E 的报错原文

```
toDataURL_ERROR=SecurityError: Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.
pixelRead_ERROR=SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.
```

### 7.3 替代方案评估（按推荐顺序）

| 方案 | 状态 | 说明 |
| --- | --- | --- |
| `useCORS: true` | ✅ **已实测可用，首选** | 跨域图片正常绘制、canvas 未污染、导出成功；对 `file://` 同样有效 |
| `<img crossorigin="anonymous">` | ✅ 推荐叠加 | 实测非必需（用例 D 通过），作为双保险与缓存边界情况的保护 |
| `allowTaint: true` | ❌ **禁止使用** | 图片能画上但 canvas 被污染，`toDataURL()` 抛 SecurityError |
| `foreignObjectRendering: true` | ❌ **本环境无效** | 用例 H 实测图片区域仍为背景色；且该路径对 CSS 支持更差，不建议启用 |
| `proxy` 选项 | ➖ 不适用 | 需服务端中转，与"纯静态、双击即用"的要求冲突 |
| 导出失败时的降级提示 | ✅ 建议 | 若个别图床未来不再返回 ACAO，可在导出前用 `fetch(url, {mode:'cors'})` 探活，失败则该图回退本地占位图并在 UI 提示，而不是产出一张缺图的截图 |

---

## 8. 复现步骤

1. 确认 `vendor/html2canvas.min.js` 存在且 SHA-256 为 `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb`；
2. 把附录 A 的完整源码另存为 `vendor/.selftest.html`（**测试完请删除**，本次验证后已删除）；
3. 执行 §3.1 的命令；
4. 在 stderr 中检索 `H2CRES|` 前缀的运行时输出：应看到 `SELFTEST_DONE|cases_resolved=6|cases_rejected=0`，且用例 B/D/G 为 `IMAGE_RENDERED`、用例 A/H 为 `IMAGE_MISSING`、用例 E 为 `toDataURL_ERROR=SecurityError`。

---

## 9. 已知边界与未覆盖项

- 仅在 **Chrome 153.0.8010.53 headless（`--headless=new`）** 实测；**未测** Firefox / Safari / Edge 及有头模式。Firefox 对 `file://` 的跨域与 `foreignObject` 行为可能不同。
- 实测 headless 环境 `devicePixelRatio=1`，因此输出 canvas 与元素尺寸一致（320×400）；在 `devicePixelRatio=2` 的高分屏上 html2canvas 默认会按 dpr 放大输出（可用 `scale` 控制），该路径**未实测**。
- 跨域图片来源仅验证了 `game.gtimg.cn`（已验证返回 `Access-Control-Allow-Origin: *`）。若站点后续引入其它图床，需确认其同样返回 ACAO，否则该图会在 `useCORS: true` 下加载失败（html2canvas 会跳过加载失败的图）。
- **离线场景**：站点自身的 HTML/CSS/JS 已完全本地化（无 CDN 依赖），但英雄图片是外链 `game.gtimg.cn`。断网时图片本身不可达，截图将缺少图片——这属于站点素材策略问题，不在本任务范围内，建议按 §7.3 的降级提示处理。

---

## 附录 A：测试页完整源码（`vendor/.selftest.html`，验证后已删除）

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>html2canvas file:// selftest v3</title>
<!-- loads the LOCAL vendored copy; no CDN involved -->
<script src="./html2canvas.min.js"></script>
</head>
<body style="margin:0;padding:0;background:#111;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#eee">
<div id="stages"></div>
<pre id="log" style="background:#000;color:#0f0;padding:8px;font-size:12px;white-space:pre-wrap"></pre>
<script>
(function () {
  var lines = [];
  function emit(s) {
    lines.push(s);
    document.getElementById('log').textContent = lines.join('\n');
    try { console.log('H2CRES|' + s); } catch (e) { /* ignore */ }
  }
  window.addEventListener('error', function (ev) {
    emit('UNCAUGHT|' + (ev.message || 'error') + '|at=' + (ev.filename || '?') + ':' + (ev.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    emit('UNHANDLED_REJECTION|' + (r && r.name ? (r.name + ': ' + r.message) : String(r)));
  });

  function errText(e) { return e ? ((e.name || 'Error') + ': ' + (e.message || String(e))) : 'unknown'; }
  function sum(r, g, b) { return r + g + b; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  var HERO_A = 'https://game.gtimg.cn/images/yxzj/img201606/heroimg/105/105.jpg'; // task-specified image
  var HERO_B = 'https://game.gtimg.cn/images/yxzj/img201606/heroimg/106/106.jpg'; // variant without crossOrigin attr
  var BOX = 180;

  function dataUriImage() {
    var c = document.createElement('canvas');
    c.width = c.height = BOX;
    var x = c.getContext('2d');
    for (var i = 0; i < 9; i++) {
      x.fillStyle = (i % 2 === 0) ? '#e23b3b' : '#2b6be2';
      x.fillRect((i % 3) * 60, Math.floor(i / 3) * 60, 60, 60);
    }
    return c.toDataURL('image/png');
  }

  function buildStage(id, title, src, useCrossOriginAttr) {
    var stage = document.createElement('div');
    stage.id = id;
    stage.style.cssText = 'position:relative;width:320px;height:400px;background:#101820;' +
      'padding:10px;box-sizing:border-box;border:2px solid #c8aa6e;margin:6px;float:left';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:16px;font-weight:700;color:#f0e6d2';
    h.textContent = title;
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:' + BOX + 'px;height:' + BOX + 'px;margin-top:8px;background:#ffffff';
    var img = document.createElement('img');
    img.style.cssText = 'display:block;width:' + BOX + 'px;height:' + BOX + 'px';
    if (useCrossOriginAttr) img.crossOrigin = 'anonymous';   // MUST precede src
    stage.appendChild(h); stage.appendChild(box); box.appendChild(img);
    document.getElementById('stages').appendChild(stage);
    var mode = useCrossOriginAttr ? 'crossOrigin=anonymous' : 'no-crossOrigin-attr';

    var loaded = new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; emit('RESULT|load|' + id + '|timeout|12000ms'); resolve(false);
      }, 12000);
      img.onload = function () {
        if (done) return; done = true; clearTimeout(timer);
        emit('RESULT|load|' + id + '|ok|mode=' + mode + '|natural=' + img.naturalWidth + 'x' + img.naturalHeight);
        resolve(true);
      };
      img.onerror = function () {
        if (done) return; done = true; clearTimeout(timer);
        emit('RESULT|load|' + id + '|ERROR|mode=' + mode); resolve(false);
      };
      img.src = src;
    });
    return { id: id, stage: stage, img: img, src: src, loaded: loaded, ref: null };
  }

  // reference pixels: load a CLEAN CORS copy of the same URL, then draw + read it.
  // (drawing the DOM's non-CORS img would taint the reference canvas -- that is the very defect under test)
  function reference(src) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.crossOrigin = 'anonymous';
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true; resolve({ ok: false, error: 'reference load timeout' });
      }, 12000);
      im.onload = function () {
        if (done) return; done = true; clearTimeout(timer);
        try {
          var c = document.createElement('canvas');
          c.width = c.height = BOX;
          var x = c.getContext('2d');
          x.fillStyle = '#ffffff'; x.fillRect(0, 0, BOX, BOX);
          x.drawImage(im, 0, 0, BOX, BOX);
          resolve({ ok: true, stats: statsOf(x.getImageData(0, 0, BOX, BOX).data) });
        } catch (e) { resolve({ ok: false, error: errText(e) }); }
      };
      im.onerror = function () {
        if (done) return; done = true; clearTimeout(timer);
        resolve({ ok: false, error: 'reference image load failed' });
      };
      im.src = src;
    });
  }

  function statsOf(data) {
    var n = data.length / 4, r = 0, g = 0, b = 0, nonWhite = 0, nonTransparent = 0;
    for (var i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      if (data[i + 3] > 0) nonTransparent++;
      if (sum(data[i], data[i + 1], data[i + 2]) < 720) nonWhite++;
    }
    return { n: n, r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), nonWhite: nonWhite, nonTransparent: nonTransparent };
  }

  function regionStats(canvas, stage, img) {
    var ctx = canvas.getContext('2d');
    var sx = canvas.width / stage.offsetWidth, sy = canvas.height / stage.offsetHeight;
    var sr = stage.getBoundingClientRect(), ir = img.getBoundingClientRect();
    var pad = 3;
    var rx = Math.round((ir.left - sr.left + pad) * sx), ry = Math.round((ir.top - sr.top + pad) * sy);
    var rw = Math.round((ir.width - 2 * pad) * sx), rh = Math.round((ir.height - 2 * pad) * sy);
    var s = statsOf(ctx.getImageData(rx, ry, rw, rh).data);
    s.rect = rx + ',' + ry + ',' + rw + 'x' + rh;
    return s;
  }

  function verdict(reg, refRes) {
    if (!reg) return 'NO_PIXELS_READ';
    if (!refRes || !refRes.ok) return 'NO_REFERENCE(' + (refRes ? refRes.error : 'null') + ')';
    var ref = refRes.stats;
    var delta = (Math.abs(reg.r - ref.r) + Math.abs(reg.g - ref.g) + Math.abs(reg.b - ref.b)) / 3;
    var refRatio = ref.nonWhite / ref.n, regRatio = reg.nonWhite / reg.n;
    var drawn = delta < 12 && Math.abs(regRatio - refRatio) < 0.12;
    return (drawn ? 'IMAGE_RENDERED' : 'IMAGE_MISSING') + '|avgDelta=' + delta.toFixed(1) +
      '|refRatio=' + refRatio.toFixed(3) + '|regionRatio=' + regRatio.toFixed(3);
  }

  function runCase(label, obj, opts) {
    var t = performance.now();
    return html2canvas(obj.stage, opts).then(function (canvas) {
      var ms = Math.round(performance.now() - t);
      var urlLen = -1, urlErr = '', reg = null, regErr = '';
      try { urlLen = canvas.toDataURL('image/png').length; } catch (e) { urlErr = errText(e); }
      try { reg = regionStats(canvas, obj.stage, obj.img); } catch (e) { regErr = errText(e); }
      var out = 'RESULT|' + label + '|opts=' + JSON.stringify(opts) + '|resolved_ms=' + ms +
        '|canvas=' + canvas.width + 'x' + canvas.height + '|dataURLlen=' + (urlErr ? 'N/A' : urlLen);
      if (urlErr) out += '|toDataURL_ERROR=' + urlErr;
      if (regErr) out += '|pixelRead_ERROR=' + regErr;
      if (reg) out += '|region[' + reg.rect + ']|avg=' + reg.r + ',' + reg.g + ',' + reg.b + '|nonWhiteRatio=' + (reg.nonWhite / reg.n).toFixed(3);
      out += '|verdict=' + verdict(reg, obj.ref);
      emit(out);
      return true;
    }).catch(function (e) {
      emit('RESULT|' + label + '|opts=' + JSON.stringify(opts) + '|REJECTED_ms=' +
        Math.round(performance.now() - t) + '|' + errText(e));
      return false;
    });
  }

  function main() {
    emit('RESULT|env|protocol=' + location.protocol + '|origin=' + location.origin + '|headless=' + /Headless/i.test(navigator.userAgent));
    emit('RESULT|env|html2canvas_typeof=' + (typeof html2canvas) + '|version_prop=' + (window.html2canvas && window.html2canvas.version ? window.html2canvas.version : 'undefined(UMD exposes none)'));

    var s1 = buildStage('stage1', 'A/B/H: 105.jpg crossOrigin=anonymous', HERO_A, true);
    var s2 = buildStage('stage2', 'D/E: 106.jpg no crossOrigin attr', HERO_B, false);
    var s3 = buildStage('stage3', 'G: data:URI inline control', dataUriImage(), false);

    Promise.all([s1.loaded, s2.loaded, s3.loaded, reference(HERO_A), reference(HERO_B), reference(s3.src)])
      .then(function (res) {
        var loads = res.slice(0, 3), refs = res.slice(3);
        emit('RESULT|load_summary|ok=' + loads.filter(Boolean).length + '/3');
        s1.ref = refs[0]; s2.ref = refs[1]; s3.ref = refs[2];
        function refLine(tag, r) {
          emit('RESULT|reference|' + tag + '|' + (r.ok
            ? ('avg=' + r.stats.r + ',' + r.stats.g + ',' + r.stats.b + '|nonWhiteRatio=' + (r.stats.nonWhite / r.stats.n).toFixed(3))
            : ('FAILED|' + r.error)));
        }
        refLine('105.jpg', s1.ref); refLine('106.jpg', s2.ref); refLine('dataURI', s3.ref);

        var ok = 0, fail = 0;
        function step(fn) { return function (r) { if (r !== undefined) { r ? ok++ : fail++; } return fn(); }; }
        var chain = Promise.resolve(true);
        chain = chain.then(step(function () { return runCase('A_spec_call_default', s1, { backgroundColor: '#000' }); }));
        chain = chain.then(step(function () { return runCase('B_useCORS', s1, { backgroundColor: '#000', useCORS: true }); }));
        chain = chain.then(step(function () { return runCase('H_foreignObject_useCORS', s1, { backgroundColor: '#000', useCORS: true, foreignObjectRendering: true }); }));
        chain = chain.then(step(function () { return runCase('D_noAttr_useCORS', s2, { backgroundColor: '#000', useCORS: true }); }));
        chain = chain.then(step(function () { return runCase('E_allowTaint_only', s2, { backgroundColor: '#000', allowTaint: true }); }));
        chain = chain.then(step(function () { return runCase('G_dataURI_default', s3, { backgroundColor: '#000' }); }));
        chain = chain.then(function () {
          emit('SELFTEST_DONE|cases_resolved=' + ok + '|cases_rejected=' + fail);
        }).catch(function (e) {
          emit('SELFTEST_FATAL|' + errText(e));
          emit('SELFTEST_DONE|cases_resolved=' + ok + '|cases_rejected=' + fail + '|fatal=1');
        });
      })
      .catch(function (e) { emit('SELFTEST_FATAL|outer|' + errText(e)); });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') main();
  else document.addEventListener('DOMContentLoaded', main);
})();
</script>
</body>
</html>
```

## 附录 B：原始日志

本次运行的原始输出保存在系统临时目录（不属于交付内容，可能被系统清理）：

- `%TEMP%\h2c-dumpdom5.txt`（`--dump-dom` 的 DOM 快照）
- `%TEMP%\h2c-stderr5.txt`（含 `H2CRES|` 运行时行，本报告 §4 的输出即取自此处）

## 附录 C：交付物清单

| 文件 | 说明 |
| --- | --- |
| `vendor/html2canvas.min.js` | html2canvas 1.4.1 官方压缩产物原样副本，198,689 字节 |
| `vendor/NOTICE.md` | 版本、作者、仓库、MIT 许可证、来源 URL、下载日期、大小、SHA-256、校验命令 |
| `scripts/REPORT-html2canvas.md` | 本报告 |

临时测试页 `vendor/.selftest.html` 已删除；`vendor/` 中仅保留上述交付文件。
