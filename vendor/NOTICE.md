# 第三方库声明 — html2canvas

本目录（`vendor/`）存放站点运行所需的本地第三方库。站点为纯静态站点，双击 `index.html` 即可运行，**运行时不依赖任何 CDN**。

---

## html2canvas

| 项目 | 内容 |
| --- | --- |
| 库名 | html2canvas |
| 版本 | **1.4.1** |
| 文件名 | `vendor/html2canvas.min.js` |
| 作者 | Niklas von Hertzen |
| 项目主页 | <https://html2canvas.hertzen.com> |
| 源码仓库 | <https://github.com/niklasvh/html2canvas> |
| 许可证 | **MIT**（MIT License） |
| 文件大小 | **198,689 字节**（194.0 KiB ≈ 198.7 KB） |
| SHA-256 | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` |
| 下载日期 | 2026-09-30（Asia/Shanghai） |
| 主来源 URL | <https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js> |
| 备用来源 URL | <https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js> |

下载时两个来源均可用，并且**两个来源下载到的文件 SHA-256 完全一致**（`e87e5507…eab8cb`，均为 198,689 字节），因此可以确认文件未在传输中被篡改或截断。

### 文件内版权头（文件首行原文）

```
/*!
 * html2canvas 1.4.1 <https://html2canvas.hertzen.com>
 * Copyright (c) 2022 Niklas von Hertzen <https://hertzen.com>
 * Released under MIT License
 */
```

### MIT License 正文

> 以下正文取自上游发布包 `html2canvas@1.4.1/LICENSE`（<https://unpkg.com/html2canvas@1.4.1/LICENSE>），文字与上游一致，仅按本文件宽度重新折行。注意：包内 `LICENSE` 文件写的是 `Copyright (c) 2012`，而 `dist/html2canvas.min.js` 头部注释写的是 `Copyright (c) 2022`，两者为同一作者的同一许可，此处如实并列。

```
MIT License

Copyright (c) 2012 Niklas von Hertzen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 使用方式

```html
<script src="vendor/html2canvas.min.js"></script>
```

导出截图时**必须**传入 `useCORS: true`，否则跨域英雄图片会被静默跳过（不报错，但导出图上没有图片）：

```js
html2canvas(element, { backgroundColor: '#000', useCORS: true }).then(canvas => {
  const dataUrl = canvas.toDataURL('image/png');
});
```

不要使用 `allowTaint: true`（会污染 canvas，导致 `toDataURL()` 抛 SecurityError）。完整实测证据见 `scripts/REPORT-html2canvas.md`。

## 重新校验本文件

```powershell
$f = "vendor\html2canvas.min.js"
(Get-Item $f).Length                                        # 期望 198689
(Get-FileHash $f -Algorithm SHA256).Hash.ToLower()          # 期望 e87e5507...eab8cb
node --check $f                                             # 期望无输出、exit code 0
```

## 备注

- 本文件是官方 npm 发布产物 `dist/html2canvas.min.js` 的**原样副本**，未做任何修改。
- 该库为浏览器端 UMD 打包产物（非 Node 模块），`node --check` 仅用于验证语法可解析，不能在 Node 中 `require` 运行。
- 站点其它运行时不依赖任何第三方库；除本文件外 `vendor/` 不含其它资源。
