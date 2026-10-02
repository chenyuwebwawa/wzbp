# wzbp 联网版 · 接口与数据契约（冻结）

> 本文件是**前后端并行开发的唯一契约**。任何一方改动都必须同步改这里，并在消息里说明。
> 版本：**v2**（2026-10-02 更新：kpl 赛制改为 B2P3→B3P2、新增全局 BP 池、错误码表、若干裁决）
> v2 变更摘要见文末[附录 A](#附录-av1--v2-变更)。

---

## 0. 总体架构

```
浏览器 ──https──► 宝塔 nginx ──┬── 静态文件（网站根目录 = 项目根目录）
                              └── /api/ 与 /api/stream ──► Node 服务 127.0.0.1:8787 ──► MySQL
```

- 站点既能在 `file://` 下当纯静态用（**联网功能自动隐藏**），也能部署到服务器走 `http(s)://`。
  > 实测：`file://` 页面**无法**访问本机 http 服务（Chrome 一律拦截，加 CORS 头也没用），
  > 所以联网功能**必须**通过 nginx/服务器以 http(s) 提供。
- 前端探测：启动时 `GET /api/health`，成功即进入「联网模式」，失败则保持纯静态模式。
- 实时更新用 **SSE**（`EventSource`），不用 WebSocket：宝塔 nginx 反代 SSE 只需关掉缓冲，零依赖。

---

## 1. 身份

匿名 + 昵称，不做账号系统。

- 客户端本地生成并保存 `playerKey`（UUID，存 localStorage `wzbp.player.key`）与 `nickname`（`wzbp.player.name`）。
- 所有写操作带 `playerKey`；服务端据此识别「我是谁」。
- 请求头可带 `X-Player-Key`，或放在 body 里，两者皆可（服务端先看 header）。

---

## 2. 数据库（MySQL 8 / utf8mb4）

数据库名 `wzbp`。所有时间字段用 `DATETIME(3)`（毫秒精度，回放需要）。

```sql
-- 房间
CREATE TABLE rooms (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(12)  NOT NULL UNIQUE,      -- 6 位房间号（大写字母+数字，去掉易混字符）
  name          VARCHAR(80)  NOT NULL DEFAULT '',
  mode          VARCHAR(24)  NOT NULL DEFAULT 'ranked',  -- ranked | kpl | peak | random
  series_count  INT          NOT NULL DEFAULT 1,   -- 系列赛局数（BO N），1..9
  status        VARCHAR(16)  NOT NULL DEFAULT 'waiting', -- waiting | drafting | finished
  current_game  INT          NOT NULL DEFAULT 1,   -- 当前第几局
  order_json    JSON         NULL,                 -- 本局顺序蓝图；NULL=按内置赛制
  created_at    DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  INDEX idx_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 房间成员（每队最多 5 人）
CREATE TABLE players (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  room_id     BIGINT      NOT NULL,
  player_key  VARCHAR(64) NOT NULL,
  nickname    VARCHAR(40) NOT NULL,
  team        VARCHAR(8)  NOT NULL,                -- blue | red
  slot        INT         NOT NULL,                -- 0..4
  joined_at   DATETIME(3) NOT NULL,
  last_seen   DATETIME(3) NOT NULL,
  UNIQUE KEY uk_room_key (room_id, player_key),
  UNIQUE KEY uk_room_slot (room_id, team, slot),
  INDEX idx_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 系列赛
CREATE TABLE series (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  room_id      BIGINT     NOT NULL,
  game_no      INT        NOT NULL,
  mode         VARCHAR(24) NOT NULL,
  order_json   JSON       NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'drafting',  -- drafting | done
  winner       VARCHAR(8) NULL,                    -- blue | red | NULL
  started_at   DATETIME(3) NOT NULL,
  finished_at  DATETIME(3) NULL,
  UNIQUE KEY uk_room_game (room_id, game_no),
  INDEX idx_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 每一步动作（回放的唯一数据源）
CREATE TABLE actions (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  series_id   BIGINT      NOT NULL,
  seq         INT         NOT NULL,                -- 第几手，从 1 开始
  step_index  INT         NOT NULL,                -- 对应顺序蓝图的下标，从 0 开始
  side        VARCHAR(8)  NOT NULL,                -- blue | red
  `action`    VARCHAR(8)  NOT NULL,                -- ban | pick（action 是 MySQL 关键字，必须加反引号）
  hero_id     INT         NOT NULL,
  hero_name   VARCHAR(40) NOT NULL,
  player_key  VARCHAR(64) NULL,
  nickname    VARCHAR(40) NULL,
  acted_at    DATETIME(3) NOT NULL,
  gap_ms      INT         NOT NULL DEFAULT 0,      -- 距上一手的间隔（第一手为距开局）
  UNIQUE KEY uk_series_seq (series_id, seq),
  INDEX idx_series (series_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

> 注意：`actions.gap_ms` 由服务端算好并落库，保证回放不依赖客户端时钟。
>
> 另一条：`actions.action` 是 **MySQL 关键字**，列名与所有 SQL 里都必须加反引号，
> 否则 MySQL 8 会报 1063/1064 直接建表失败。已在 `server/schema.sql` 与 `server/api.js` 落地。
> 还有一条实测结论：**MariaDB 下 `JSON` 列实为 `longtext` + `json_valid()` 校验**（不是 MySQL 8 的原生 `json`），
> 服务端读写两种形态都兼容，功能等价。

---

## 3. HTTP 接口

统一前缀 `/api`。响应统一 JSON：成功 `{ ok: true, ... }`，失败 `{ ok: false, error: "中文原因", code: "ERR_X" }`，
HTTP 状态码同时反映结果（400/403/404/409/500）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, time, db: true\|false }`，前端用它判断联网模式 |
| POST | `/api/rooms` | 建房。body `{ name, mode, seriesCount, nickname, playerKey }` → `{ ok, room }` |
| GET | `/api/rooms` | 房间列表 `{ ok, rooms: [{code,name,mode,status,players,createdAt}] }`（最多 50 个，按 updated_at 倒序） |
| POST | `/api/rooms/:code/join` | 入房。body `{ nickname, playerKey, team, slot? }` `team` = blue\|red\|auto → `{ ok, room, me }` |
| POST | `/api/rooms/:code/leave` | 离房。body `{ playerKey }` → `{ ok }` |
| GET | `/api/rooms/:code/state` | 全量状态 → `{ ok, room, players, series, game, actions, me }`（见 §4） |
| GET | `/api/stream?code=XXXX&playerKey=...` | **SSE** 事件流（见 §5） |
| POST | `/api/rooms/:code/shuffle` | 重新随机本局顺序（仅 mode=random 有意义）→ `{ ok, order }` |
| POST | `/api/rooms/:code/action` | 落一手。body `{ playerKey, side, action, heroId }` → `{ ok, action, game }` |
| POST | `/api/rooms/:code/undo` | 撤销上一手。body `{ playerKey }` → `{ ok, removed }` |
| POST | `/api/rooms/:code/next-game` | 结束本局、开下一局（超过 seriesCount 则整场结束）。body `{ winner?, playerKey }` → `{ ok, game }` |
| POST | `/api/rooms/:code/finish` | 直接结束整个系列。body `{ playerKey }` → `{ ok }` |
| GET | `/api/rooms/:code/history` | 历史对局列表 → `{ ok, games: [...] }` |
| GET | `/api/games/:id/replay` | 回放数据 → `{ ok, game, actions: [...], order: [...] }` |
| GET | `/api/games/recent` | 最近对局（跨房间，最多 30 条）→ `{ ok, games: [...] }` |

### 3.1 建房参数校验

- `mode` ∈ `ranked | kpl | peak | random`，非法则 400。
- `seriesCount` 1..9，非法则 400。
- `nickname` 1..20 字符（去首尾空白），空则用「玩家+4位随机」。
- `code` 生成：6 位，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（去掉 I/O/0/1）；冲突则重试，最多 10 次。

### 3.2 入房规则

- `team=auto` 时由服务端挑人少的一队、同队取最小空位。
- 每队最多 **5 人**；满员返回 409 `{code:"ERR_TEAM_FULL"}`。
- 同一 `playerKey` 已在房内 → 视为重连：更新昵称与 `last_seen`，**保持原队伍与位置**，返回既有记录
  （额外带 `reconnect:true`）。注意：**换座必须「先离后进」**，否则重连语义会把你按回原座位。
- 指定 `slot` 被占用 → 409 `ERR_SLOT_TAKEN`。

### 3.3 错误码表（v2 补充）

HTTP 状态码与 `code` 一一对应：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `ERR_BAD_MODE` / `ERR_BAD_SERIES` / `ERR_BAD_NICKNAME` / `ERR_BAD_SLOT` / `ERR_BAD_PARAM` / `ERR_BAD_JSON` | 参数不合法 |
| 403 | `ERR_NOT_IN_ROOM` | 请求方不在该房间（**优先于轮次判断**） |
| 404 | `ERR_ROOM_NOT_FOUND` / `ERR_GAME_NOT_FOUND` / `ERR_HERO_UNKNOWN` | 找不到 |
| 405 | `ERR_METHOD` | 方法不允许 |
| 409 | `ERR_NOT_YOUR_TURN` / `ERR_WRONG_ACTION` / `ERR_HERO_TAKEN` / **`ERR_HERO_GLOBAL_USED`** / `ERR_TEAM_FULL` / `ERR_SLOT_TAKEN` / `ERR_GAME_DONE` / `ERR_ROOM_FINISHED` / `ERR_ALREADY_DONE` / `ERR_ALREADY_STARTED` / `ERR_NOTHING_TO_UNDO` / `ERR_NOT_RANDOM` | 状态冲突 |
| 413 | `ERR_BODY_TOO_LARGE` | 请求体过大 |
| 500 | `ERR_INTERNAL` | 服务端异常 |

`ERR_HERO_GLOBAL_USED` 的中文提示建议：`该英雄已被蓝方在之前的小局选用（全局 BP）`。

### 3.4 权限（v2 明确）

**不做房主制**：任何在房成员都可以落子、撤销、换局、结束系列、重洗顺序。
理由：这是开黑工具不是赛事系统，加权限反而碍事。要收紧再说。

### 3.5 房间状态流转（v2 明确）

`room.status`：`waiting` --（**第一手落子时**）--> `drafting` --（打满 seriesCount 局或点了结束）--> `finished`。


---

## 4. 状态对象（`GET /api/rooms/:code/state`）

```jsonc
{
  "ok": true,
  "room": {
    "code": "A7K2M9", "name": "周五训练赛", "mode": "random",
    "seriesCount": 3, "status": "drafting", "currentGame": 2,
    "createdAt": "2026-10-02T13:00:00.000Z", "updatedAt": "..."
  },
  "players": [
    { "nickname": "老王", "team": "blue", "slot": 0, "isMe": true, "online": true }
  ],
  "series": { "id": 12, "gameNo": 2, "status": "drafting", "winner": null,
              "order": [ { "s":"blue","a":"ban","p":"第一轮禁用","t":"蓝方 ban 1" }, ... ] },
  "game": {
    "id": 12, "gameNo": 2, "status": "drafting",
    "stepIndex": 5,          // 已完成的蓝图步数（peak 的 both,n=3 会一步吃 6 手）
    "actionsInStep": 0,      // 当前步骤内已出手数（v2 新增，peak 用得到）
    "nextAction": { "side": "red", "action": "ban" },   // side 可能是 'both'
    "done": false,
    "bans": { "blue": [], "red": [] },     // 数组元素是 heroId
    "picks": { "blue": [], "red": [] },
    "global": true,                        // v2 新增：本局是否全局 BP
    "globalUsed": { "blue": [105], "red": [] },  // v2 新增：本系列赛各队已选英雄
    "startedAt": "...", "finishedAt": null
  },
  "actions": [
    { "seq":1, "stepIndex":0, "side":"blue", "action":"ban", "heroId":105,
      "heroName":"廉颇", "nickname":"老王", "actedAt":"...", "gapMs":1234 }
  ],
  "me": { "nickname": "老王", "team": "blue", "slot": 0 }
}
```

- `game.stepIndex` = **已完成的蓝图步数**，不是 `actions.length`：
  巅峰赛的 `{s:'both',a:'ban',n:3}` 一步要吃 6 手（蓝 3 + 红 3），此时 `stepIndex=1` 而 `actions.length=6`。
  普通赛制下两者恰好相等。需要「当前步走了几手」就读 `game.actionsInStep`。
- `order` 是**本局实际使用的顺序蓝图**：内置赛制直接给内置 steps；`random` 模式给随机结果。
  回放与还原只看 `order` + `actions`，不依赖前端内置赛制表。
- SSE 下发的 `state` 与上面同构，但 **`me`/`isMe` 是按连接个性化的**（每人看到自己的身份）。


### 4.1 动作校验（服务端权威）
`POST /action` 必须校验，全部通过才落库。**校验顺序**（v2 调整）：

1. 房间存在、非 `finished`。
2. **请求方 `playerKey` 在该房间内** → 否则 403 `ERR_NOT_IN_ROOM`（提到最前，避免未入房者拿到轮次信息）。
3. 系列处于 `drafting` → 否则 409 `ERR_GAME_DONE`。
4. `order[stepIndex]` 存在；`side` 与 `action` 必须与蓝图一致（`'both'` 允许双方）。
   失败分别 409 `ERR_NOT_YOUR_TURN` / `ERR_WRONG_ACTION`。
5. 该英雄本局未被 ban/pick 过 → 否则 409 `ERR_HERO_TAKEN`。
6. **全局 BP**（见 §6.1）：`action='pick'` 且本局为全局 BP 时，
   若 `heroId` 出现在**同侧**的 `globalUsed` 里 → 409 `ERR_HERO_GLOBAL_USED`。
7. 该英雄存在（服务端持有英雄 id 白名单，见 §7）→ 否则 404 `ERR_HERO_UNKNOWN`。

---

## 5. SSE 事件流

`GET /api/stream?code=XXXX&playerKey=...`，`Content-Type: text/event-stream`。

事件名（`event:` 字段）+ `data:` JSON：

| event | data | 说明 |
| --- | --- | --- |
| `hello` | `{ serverTime }` | 连接建立 |
| `state` | 同 §4 全量状态 | 任何变更后广播（简单可靠，先不做增量） |
| `action` | `{ action, game }` | 有人落了一手（便于前端播放音效/动画） |
| `presence` | `{ players }` | 成员进出 |
| `game` | `{ game }` | 换局 / 结束 |
| `ping` | `{}` | 每 20 秒，防反代超时 |

- 服务端每 20 秒发一次注释行 `: ka`，并在 30 秒无心跳时清理连接。
- 广播范围：同一房间所有连接。
- **前端断线重连**：`EventSource` 自带重连；重连成功后服务端立即补一条 `state`。

---

## 6. 赛制与顺序（v2 更新）

### 6.1 `kpl`：全局 BP，B2P3 → B3P2（20 手）

**每队 5 ban + 5 pick，共 20 手**：

| 阶段 | 手数 | 顺序 |
| --- | --- | --- |
| 第一轮 B2P3 | 10 | 蓝ban 红ban 红ban 蓝ban → 红pick 蓝pick 蓝pick 红pick 红pick 蓝pick |
| 第二轮 B3P2 | 10 | 红ban 蓝ban 蓝ban 红ban 红ban 蓝ban → 红pick 蓝pick 蓝pick 红pick |

- 第一轮：双方各 2 ban、各 3 pick（pick 由红方先手）
- 第二轮：双方各 3 ban、各 2 pick（pick 由红方先手）
- 合计：10 ban + 10 pick

**全局 BP 规则（依据 KPL 官方口径，单边限制）**：

1. **本方**在本系列赛**选过**的英雄，本方后续小局不能再选；
2. **对方**选过的英雄，本方不受影响；
3. **禁用不进全局池** —— 每局 ban 只在本局生效，上一局被 ban 过的英雄本局仍可选/可 ban；
4. 换局**不清空**全局池；开新房 / 换系列赛清空；
5. 仅 `kpl` 启用；`ranked` / `peak` / `random` 的 `game.global` 恒为 `false`。

服务端按 `room_id` 聚合全部小局的 `action='pick'` 得到两端池子，下发给客户端：
`game.globalUsed = { blue: [heroId…], red: [heroId…] }`。

客户端 `js/draft.js` 也内置同一套兜底校验（`setGlobalUsed()` / `globalUsed`），
离线单机演示时行为一致。

### 6.2 `random`：随机征召（顺序随机，英雄仍手动选）

1. 开局由服务端洗牌生成本局 `order`：
   - 基准配比取 **ranked** 的 6 ban + 10 pick（不由 kpl 派生）
   - ban 段与 pick 段**各自**洗牌，但保证：每队 ban 数/pick 数不变、pick 段仍以蓝方先手、
     不出现连续同队 3 手以上
   - 结果写入 `series.order_json`，全房间共享
2. `POST /shuffle` 可重洗，但**仅在本局尚未落任何一手时**允许，否则 409 `ERR_ALREADY_STARTED`。
3. 客户端拿到 `order` 后用 `draft.setOrder(order, 'random', {global:false})` 注入引擎；
   渲染与回放**不使用内置赛制表**。

### 6.3 其余赛制

- `ranked` 排位征召：6 ban + 10 pick = 16 手（蓝1 红2 蓝2 红1 → 交替选人）
- `peak` 巅峰赛：`{s:'both',a:'ban',n:3}` 一步双方各 3 ban + 10 pick = 11 步


---

## 7. 英雄白名单

服务端启动时读 `data/heroes.js`，用正则提取 `"id": <数字>` 与 `"name": "<中文>"` 建映射
（**不执行该文件**，避免往服务端引入浏览器全局）。校验 `heroId` 合法性，并给 `actions.hero_name` 填名字。
提取失败（文件缺失/格式变了）时降级为「不校验英雄存在性」，并在 `/api/health` 里标 `heroList: false`。

---

## 8. 前端接入点

| 文件 | 归属 | 说明 |
| --- | --- | --- |
| `js/net.js` | 前端 | 探测 `/api/health`、封装 REST、SSE 订阅与自动重连、身份读写 |
| `js/room-ui.js` | 前端 | 大厅 / 建房 / 加入 / 战队席位 / 系列赛控制台（顶部抽屉） |
| `js/replay-ui.js` | 前端 | 历史对局列表 + 时间轴回放（拖动进度条看每一步） |
| `server/**` | 后端 | 见 §9 |
| `docs/宝塔部署教程.md` | 文档 | 部署步骤，由前端负责人统筹 |
| `package.json` | 后端 | 依赖 `mysql2`；`start` 脚本 |

前端在联网模式下：
- 顶栏出现「房间」入口；
- 本机自己的 BP 操作改为 `POST /action`（乐观更新 + 失败回滚），并停止本地草稿覆盖；
- 展示板 / 采集页仍是只读渲染，通过 SSE 的 `state` 驱动（与现有 `sync.js` 并存：
  同机多窗口走 `sync.js`，跨机走 SSE；二者都以「服务端 state」为准）。

---

## 9. 后端文件结构

```
server/
├── index.js        HTTP 路由 + 静态文件 + SSE 注册表 + 启动
├── db.js           MySQL 连接池（mysql2/promise）、建表、健康检查
├── schema.sql      建表 SQL（与 §2 一致，可重复执行）
├── config.js       端口/数据库配置（读环境变量，带默认值）
├── heroes.js       英雄白名单提取（§7）
├── draft.js        顺序蓝图：内置赛制镜像 + 随机洗牌（§6）
└── api.js          REST 实现（房间/成员/动作/历史/回放）
```

- 监听 `127.0.0.1:PORT`（默认 `8787`，环境变量 `WZBP_PORT`），**只监听本机**，由 nginx 反代。
- 数据库环境变量：`WZBP_DB_HOST/PORT/USER/PASSWORD/NAME`。
- 启动时自动建库建表（`CREATE DATABASE IF NOT EXISTS` + `schema.sql`），失败则打印中文提示并退出码 1。
- 提供 `npm run dev`（同 start）；不需要构建步骤。

---

## 10. 验收（双方各自自检）

- 后端：`scripts/verify-server.mjs` —— 用 Node 内置 `http` 直连服务，覆盖建房/入房/满员/落一手/重复英雄/越权/撤销/换局/历史/回放/SSE 至少收到 3 类事件；**不需要浏览器**。
- 前端：`scripts/verify-net-ui.mjs` —— headless Chrome 开两个页面（模拟两名玩家）通过真实服务联调。
- 兼容：现有 `verify-engine.mjs` / `verify-ui.js` / `verify-sync.mjs` / `verify-overlay.mjs` / `verify-offline.mjs` 必须继续全绿。

---

## 附录 A：v1 → v2 变更

| 项 | v1 | v2 |
| --- | --- | --- |
| `kpl` 赛制 | 3+3 ban → 6 pick → 2+2 ban → 4 pick | **B2P3 → B3P2**（第一轮各 2ban/3pick，第二轮各 3ban/2pick） |
| 全局 BP | 未定义 | **新增**：单边限制 + `game.global` / `game.globalUsed` + `ERR_HERO_GLOBAL_USED` |
| `game.stepIndex` | 说「等于 actions.length」 | 改为**已完成的蓝图步数**；另加 `game.actionsInStep`（peak 的 `both,n=3` 一步吃 6 手） |
| SSE `state` 的 `me` | 未说明 | 明确为**按连接个性化** |
| 校验顺序 | 「在房内」放最后 | 提前到第 2 位（未入房 → 403 优先） |
| 错误码 | 只列 4 个 | 补全 §3.3 共 32 个码 |
| 权限 | 未定义 | 明确**不做房主制**，任何在房成员可操作 |
| 房间状态流转 | 未定义 | 明确「第一手落子时 waiting → drafting」 |
| `action` 列名 | 裸写 | 因是 MySQL 关键字，schema 与 SQL **一律加反引号** |
| 房间列表 `players` | 类型未定 | = **人数(number)**，另附 `members`(数组) 与 `playerCount` |
| 表数量 | 笔误写 5 张 | 以 §2 的 **4 张**为准 |
| `/history`、`/games/recent` 列表项 | 无阵容 | 新增 `picks` / `bans`（heroId 数组，未开打为空数组） |

### v2 已知的实现取舍

- `server/memory-driver.js` 是「无 MySQL 环境下跑全链路自检」的**自检专用驱动**，
  仅在 `WZBP_DB_DRIVER=memory` 时加载，启动会打印告警；**生产路径不经它**。
- 本机开发验证用的是免安装 **MariaDB 11.4.5**（MySQL 协议兼容）；
  初始化用 `mysql_install_db.exe`（**不是** MySQL 的 `--initialize-insecure`）。

