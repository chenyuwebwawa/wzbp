-- ============================================================
-- wzbp · 数据库结构（与 docs/API-契约.md §2 完全一致）
-- 可重复执行：全部 IF NOT EXISTS。
-- 手工导入：mysql -uroot -p < server/schema.sql
-- 服务端启动时会自动执行本文件（db.js 会按 WZBP_DB_NAME 改写库名）。
-- ============================================================

CREATE DATABASE IF NOT EXISTS `wzbp` DEFAULT CHARACTER SET utf8mb4;

USE `wzbp`;

-- 房间
CREATE TABLE IF NOT EXISTS rooms (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(12)  NOT NULL UNIQUE,
  name          VARCHAR(80)  NOT NULL DEFAULT '',
  mode          VARCHAR(24)  NOT NULL DEFAULT 'ranked',
  series_count  INT          NOT NULL DEFAULT 1,
  status        VARCHAR(16)  NOT NULL DEFAULT 'waiting',
  current_game  INT          NOT NULL DEFAULT 1,
  order_json    JSON         NULL,
  created_at    DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  INDEX idx_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 房间成员（每队最多 5 人）
CREATE TABLE IF NOT EXISTS players (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  room_id     BIGINT      NOT NULL,
  player_key  VARCHAR(64) NOT NULL,
  nickname    VARCHAR(40) NOT NULL,
  team        VARCHAR(8)  NOT NULL,
  slot        INT         NOT NULL,
  joined_at   DATETIME(3) NOT NULL,
  last_seen   DATETIME(3) NOT NULL,
  UNIQUE KEY uk_room_key (room_id, player_key),
  UNIQUE KEY uk_room_slot (room_id, team, slot),
  INDEX idx_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 系列赛
CREATE TABLE IF NOT EXISTS series (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  room_id      BIGINT     NOT NULL,
  game_no      INT        NOT NULL,
  mode         VARCHAR(24) NOT NULL,
  order_json   JSON       NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'drafting',
  winner       VARCHAR(8) NULL,
  started_at   DATETIME(3) NOT NULL,
  finished_at  DATETIME(3) NULL,
  UNIQUE KEY uk_room_game (room_id, game_no),
  INDEX idx_room (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 每一步动作（回放的唯一数据源）
-- 注意：action 是 MySQL 关键字，列名必须加反引号，否则 MySQL 8 会报 1064 语法错误
CREATE TABLE IF NOT EXISTS actions (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  series_id   BIGINT      NOT NULL,
  seq         INT         NOT NULL,
  step_index  INT         NOT NULL,
  side        VARCHAR(8)  NOT NULL,
  `action`    VARCHAR(8)  NOT NULL,
  hero_id     INT         NOT NULL,
  hero_name   VARCHAR(40) NOT NULL,
  player_key  VARCHAR(64) NULL,
  nickname    VARCHAR(40) NULL,
  acted_at    DATETIME(3) NOT NULL,
  gap_ms      INT         NOT NULL DEFAULT 0,
  UNIQUE KEY uk_series_seq (series_id, seq),
  INDEX idx_series (series_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
