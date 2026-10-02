#!/usr/bin/env bash
# =============================================================================
#  wzbp · 王者荣耀 BP 展示台  —— Linux 一键安装脚本（宝塔面板 / 裸机通用）
# -----------------------------------------------------------------------------
#  用法（两种都支持）：
#    ① GitHub 一键（把 <owner>/<repo> 换成你的仓库，或加 --repo）：
#       bash <(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh) \
#            --domain bp.example.com
#    ② 先克隆再跑：
#       git clone <仓库> wzbp && cd wzbp && sudo bash install.sh --domain bp.example.com
#
#  参数详解：bash install.sh --help
#  本机预演：bash install.sh --dry-run --domain test.example.com   （只打印，不改系统）
#
#  这份脚本 = docs/宝塔部署教程.md 的人工步骤自动化，一一对应：
#    教程 §2 装环境        → 步骤 1 环境自检（宝塔/Node/MySQL/Nginx）
#    教程 §3 上传文件      → 步骤 2 站点目录与项目文件
#    教程 §4 建数据库      → 步骤 3 建库建用户（服务自己建表，脚本不导 schema.sql）
#    教程 §5 环境变量+试跑 → 步骤 4 写 .env
#    教程 §5 npm install   → 步骤 5 安装依赖
#    教程 §6 Node 项目常驻 → 步骤 6 常驻服务（宝塔 Node 项目 / pm2 / systemd）
#    教程 §7 站点+反代     → 步骤 7 Nginx 站点 + SSE 反代（含备份与回滚）
#    教程 §8 开 HTTPS      → 步骤 8 申请证书（失败不阻断）
#    教程 §9 验证部署      → 步骤 8 健康自检 /api/health 要求 db:true
#
#  安全设计：
#    · --dry-run 分支里所有写操作都只打印，绝不 mkdir/chmod/chown/写文件/改 Nginx
#    · 改 Nginx 前先备份 .bak.<时间戳>，nginx -t 失败自动回滚
#    · 数据库只 CREATE IF NOT EXISTS，不 DROP；密码只落在 .env（chmod 600，已 gitignore）
#    · 任何一步失败都打印「哪一步 / 为什么 / 怎么修」并非零退出
# =============================================================================

# 必须用 bash（用 sh 跑会走不通）
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\n' '请用 bash 运行本脚本：sudo bash install.sh --domain 你的域名（例如 sudo bash install.sh --help）' >&2
  exit 2
fi

set -u

SCRIPT_VERSION='1.0.0'
STEP_TOTAL=8
STEP_NO=0

# ---------------- 全局默认值 ----------------
DOMAIN=''
PORT='8787'
DIR=''
DIR_GIVEN=0
DB_NAME='wzbp'
DB_USER='wzbp'
DB_PASS=''
DB_PASS_GIVEN=0
DB_HOST='127.0.0.1'
DB_PORT='3306'
DB_ROOT_USER='root'
DB_ROOT_PASS=''
DB_ROOT_PASS_GIVEN=0
REPO_URL=''
TARBALL_URL=''
SERVICE_PREF='auto'
SSL_EMAIL=''
NO_NGINX=0
NO_SSL=0
ASSUME_YES=0
UNINSTALL=0
VERBOSE=0
DRY_RUN=0

# 检测结果
OS_KERNEL='unknown'
DISTRO='unknown'
IS_LINUX=0
PANEL_OK=0
NGINX_BIN=''
NGINX_CONF_DIR=''
MYSQL_BIN=''
MYSQLD_OK=0
NODE_BIN=''
NPM_BIN=''
RUN_USER='root'
RUN_GROUP='root'
ENGINE=''
CUR_STEP='初始化'
LAST_OUT=''
HEALTH_BODY=''
HEALTH_CODE=''
DOMAIN_IS_IP=0
NGINX_CONF_PATH=''
SERVICE_STATUS_HINT=''

# 站点目录内的固定文件名
ENV_NAME='.env'
STATE_NAME='.wzbp-install-state'
PM2_NAME='.wzbp-pm2.json'
BT_RUN_NAME="wzbp.sh"
SERVICE_NAME='wzbp'

# 时间戳：dry-run 下用占位符，保证两次 dry-run 输出完全一致
STAMP='<时间戳>'

# ---------------- 颜色（无 tty 自动降级为纯文本） ----------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != 'dumb' ]; then
  C_R=$(printf '\033[0m')
  C_B=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RD=$(printf '\033[31m')
  C_GR=$(printf '\033[32m')
  C_YL=$(printf '\033[33m')
  C_BL=$(printf '\033[36m')
else
  C_R=''; C_B=''; C_DIM=''; C_RD=''; C_GR=''; C_YL=''; C_BL=''
fi

# =============================================================================
#  输出
# =============================================================================
say()  { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_BL}·${C_R} $*"; }
ok()   { printf '%s\n' "${C_GR}✓${C_R} $*"; }
warn() { printf '%s\n' "${C_YL}!${C_R} $*"; }
err()  { printf '%s\n' "${C_RD}✗${C_R} $*" >&2; }
dim()  { printf '%s\n' "${C_DIM}$*${C_R}"; }

step() {
  STEP_NO=$((STEP_NO + 1))
  CUR_STEP="步骤 ${STEP_NO}/${STEP_TOTAL} $1"
  printf '\n%s[%s/%s]%s %s%s%s\n' "$C_B" "$STEP_NO" "$STEP_TOTAL" "$C_R" "$C_B" "$1" "$C_R"
}

# 失败：打印「哪一步 / 为什么 / 怎么修」，非零退出
die() {
  local why="$1" fix="${2:-}"
  printf '\n'
  err "安装失败：${CUR_STEP}"
  printf '%s\n' "  原因：${why}" >&2
  if [ -n "$fix" ]; then printf '%s\n' "  怎么修：${fix}" >&2; fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s\n' "  （当前是 --dry-run 模式，以上只是演练，系统没有被改动）" >&2
  fi
  exit 1
}

dry() { [ "$DRY_RUN" = 1 ]; }

# 展示命令时做转义，dry-run 输出才不含歧义
show_cmd() {
  local a out=''
  for a in "$@"; do out="${out}$(printf '%q ' "$a")"; done
  printf '%s' "$out"
}

# =============================================================================
#  dry-run 感知的原语：所有会改系统的动作都必须走这里
# =============================================================================

# run <描述> <命令...>：真实执行（输出只在失败/VERBOSE 时打印），dry-run 只打印
run() {
  local desc="$1"; shift
  if dry; then
    printf '  %s[dry-run]%s %s\n' "$C_DIM" "$C_R" "$desc"
    printf '            $ %s\n' "$(show_cmd "$@")"
    LAST_OUT=''
    return 0
  fi
  local out rc
  out=$("$@" 2>&1)
  rc=$?
  LAST_OUT="$out"
  if [ "$rc" -ne 0 ]; then
    if [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/    | /'; fi
    return "$rc"
  fi
  if [ "$VERBOSE" = 1 ] && [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/    | /'; fi
  return 0
}

# run_in_dir <目录> <描述> <命令...>：在指定目录里执行（npm 等必须在项目目录里跑）
run_in_dir() {
  local d="$1" desc="$2"; shift 2
  if dry; then
    printf '  %s[dry-run]%s %s\n' "$C_DIM" "$C_R" "$desc"
    printf '            $ (cd %s && %s)\n' "$d" "$(show_cmd "$@")"
    LAST_OUT=''
    return 0
  fi
  local out rc
  out=$(cd "$d" && "$@" 2>&1)
  rc=$?
  LAST_OUT="$out"
  if [ "$rc" -ne 0 ]; then
    if [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/    | /'; fi
    return "$rc"
  fi
  if [ "$VERBOSE" = 1 ] && [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/    | /'; fi
  return 0
}

# mkdir -p
mkp() {
  local p="$1"
  if dry; then printf '  %s[dry-run]%s 创建目录 %s\n' "$C_DIM" "$C_R" "$p"; return 0; fi
  mkdir -p "$p" 2>/dev/null || die "创建目录失败：$p" "检查路径是否正确、磁盘是否已满（df -h）、是否有写权限。"
  return 0
}

# rm -f
rmf() {
  local p="$1"
  if dry; then printf '  %s[dry-run]%s 删除文件 %s\n' "$C_DIM" "$C_R" "$p"; return 0; fi
  rm -f "$p" 2>/dev/null || warn "删除失败（可以忽略）：$p"
  return 0
}

# chmod <模式> <路径>
chmod_() {
  local mode="$1" p="$2"
  if dry; then printf '  %s[dry-run]%s chmod %s %s\n' "$C_DIM" "$C_R" "$mode" "$p"; return 0; fi
  chmod "$mode" "$p" 2>/dev/null || warn "chmod $mode $p 失败，可稍后手动执行。"
  return 0
}

# 递归改属主/权限（教程 §3.4）
chown_tree() {
  local p="$1"
  if dry; then printf '  %s[dry-run]%s chown -R %s:%s %s\n' "$C_DIM" "$C_R" "$RUN_USER" "$RUN_GROUP" "$p"; return 0; fi
  chown -R "$RUN_USER:$RUN_GROUP" "$p" 2>/dev/null || warn "chown -R $RUN_USER:$RUN_GROUP $p 失败（非致命，Node 只读文件通常仍可运行）。"
  return 0
}
chmod_tree() {
  local p="$1"
  if dry; then printf '  %s[dry-run]%s chmod -R 755 %s\n' "$C_DIM" "$C_R" "$p"; return 0; fi
  chmod -R 755 "$p" 2>/dev/null || warn "chmod -R 755 $p 失败（非致命）。"
  return 0
}

# write_file <路径> <描述>：内容从 stdin 读；dry-run 只打印内容
write_file() {
  local path="$1" desc="$2" content
  content=$(cat)
  if dry; then
    printf '  %s[dry-run]%s 写入文件 %s（%s）\n' "$C_DIM" "$C_R" "$path" "$desc"
    printf '%s\n' "$content" | sed 's/^/    | /'
    return 0
  fi
  local dirp
  dirp=$(dirname "$path")
  [ -d "$dirp" ] || mkdir -p "$dirp" 2>/dev/null || die "无法创建目录：$dirp" "检查路径与权限。"
  if [ -f "$path" ] && [ "$(cat "$path" 2>/dev/null)" = "$content" ]; then
    ok "文件内容无变化，跳过写入：$path"
    return 0
  fi
  printf '%s\n' "$content" > "$path" || die "写入文件失败：$path" "检查磁盘空间与权限（df -h）。"
  ok "已写入：$path"
  return 0
}

# 备份文件（改动前必须调用）；返回 0=已备份 1=无需备份（文件不存在）
backup_file() {
  local p="$1" bak
  [ -f "$p" ] || return 1
  bak="${p}.bak.${STAMP}"
  if dry; then
    printf '  %s[dry-run]%s 备份 %s → %s\n' "$C_DIM" "$C_R" "$p" "$bak"
    return 0
  fi
  cp -p "$p" "$bak" 2>/dev/null || die "备份失败：$p" "手动复制一份再重试（cp -p $p ${p}.bak.手动）。"
  ok "已备份：$bak"
  return 0
}

confirm() { # confirm <问题>
  if dry; then info "dry-run：跳过确认（$1）"; return 0; fi
  if [ "$ASSUME_YES" = 1 ]; then ok "已确认（--yes）：$1"; return 0; fi
  if [ ! -t 0 ]; then
    die "非交互环境无法确认：$1" "加 --yes（无人值守）或 --dry-run（只预演）。"
  fi
  printf '%s [y/N] ' "$1"
  local ans=''
  read -r ans || ans=''
  case "$ans" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) err "用户取消安装。"; exit 1 ;;
  esac
}

# =============================================================================
#  帮助
# =============================================================================
usage() {
  cat <<'USAGE'
wzbp · 王者荣耀 BP 展示台 —— Linux 一键安装脚本 v1.0.0

用法：
  sudo bash install.sh --domain <域名> [其它参数]

最常用（只填域名，其余全自动）：
  bash <(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh) \
       --domain bp.example.com
  git clone <仓库> wzbp && cd wzbp && sudo bash install.sh --domain bp.example.com

本机预演（只打印将要做什么，绝不改系统；Windows Git Bash 也能跑）：
  bash install.sh --dry-run --domain test.example.com

必填参数：
  --domain <域名>        站点域名，也允许直接填服务器 IP（如 1.2.3.4）
                         填了 http:// 或多余路径会自动清理

可选参数：
  --port <端口>          Node 服务端口，默认 8787（只监听 127.0.0.1，不对外）
  --dir <路径>           站点目录。默认：脚本所在的项目目录；
                         若不是从项目目录运行，则默认 /www/wwwroot/wzbp
  --db-name <库名>       数据库名，默认 wzbp
  --db-user <用户名>     数据库用户，默认 wzbp
  --db-pass <密码>       数据库密码，默认自动生成 24 位随机强密码
  --db-host <主机>       数据库主机，默认 127.0.0.1
  --db-port <端口>       数据库端口，默认 3306
  --db-root-user <用户>  建库用的管理员账号，默认 root
  --db-root-pass <密码>  管理员密码；不填则自动从宝塔配置里找，找不到会询问
  --repo <git 地址>      远程一键模式下自动拉取项目的 git 仓库地址
  --tarball <下载地址>   远程一键模式下用 tar.gz 包代替 git
  --service <方式>       常驻方式：auto（默认）/ bt / pm2 / systemd
  --ssl-email <邮箱>     申请 Let's Encrypt 证书用的邮箱（可选）
  --no-nginx             只装 Node 服务与数据库，不动 Nginx
  --no-ssl               不申请 HTTPS（默认会尝试，失败不阻断）
  --uninstall            卸载：停服务 + 删 Nginx 配置（不会删数据库）
  --yes, -y              非交互确认（CI / 无人值守）
  --dry-run              只打印将要执行的操作，不真的改系统
  --verbose              打印被调用命令的完整输出（排错用）
  --help, -h             显示本帮助
  --version              显示版本号

环境变量（与参数等价，参数优先）：
  WZBP_REPO              同 --repo

安装会改哪些东西：
  · 建数据库 / 数据库用户（只 CREATE IF NOT EXISTS，不 DROP、不清数据）
  · 写 <站点目录>/.env（数据库密码，chmod 600，并确保已被 .gitignore 忽略）
  · 写 <站点目录>/.wzbp-install-state（安装记录，供卸载使用）
  · 写 Nginx 站点配置：宝塔惯例 /www/server/panel/vhost/nginx/<域名>.conf
    （改动前先备份 <配置文件>.bak.<时间戳>，nginx -t 失败自动回滚）
  · 注册常驻服务：宝塔 Node 项目 / pm2 / systemd 的 wzbp.service（三选一）
  · 不改数据库表结构：表由 Node 服务第一次启动时自动建（server/schema.sql）

卸载：
  sudo bash install.sh --uninstall --domain bp.example.com
  （停服务、删 Nginx 配置；数据库与 .env 会保留并提示你手动删）

完整说明见 docs/安装脚本说明.md，人工步骤见 docs/宝塔部署教程.md
USAGE
}

usage_err() {
  err "$1"
  printf '\n' >&2
  usage >&2
  exit 2
}

# =============================================================================
#  参数解析
# =============================================================================
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --*=*)
        # 支持 --domain=xxx 写法：拆成两个参数后重新解析
        set -- "${1%%=*}" "${1#*=}" "${@:3}"
        continue
        ;;
      --domain)         shift; [ $# -gt 0 ] || usage_err '--domain 后面要跟域名'; DOMAIN="$1" ;;
      --port)           shift; [ $# -gt 0 ] || usage_err '--port 后面要跟端口'; PORT="$1" ;;
      --dir)            shift; [ $# -gt 0 ] || usage_err '--dir 后面要跟路径'; DIR="$1"; DIR_GIVEN=1 ;;
      --db-name)        shift; [ $# -gt 0 ] || usage_err '--db-name 后面要跟库名'; DB_NAME="$1" ;;
      --db-user)        shift; [ $# -gt 0 ] || usage_err '--db-user 后面要跟用户名'; DB_USER="$1" ;;
      --db-pass)        shift; [ $# -gt 0 ] || usage_err '--db-pass 后面要跟密码'; DB_PASS="$1"; DB_PASS_GIVEN=1 ;;
      --db-host)        shift; [ $# -gt 0 ] || usage_err '--db-host 后面要跟主机'; DB_HOST="$1" ;;
      --db-port)        shift; [ $# -gt 0 ] || usage_err '--db-port 后面要跟端口'; DB_PORT="$1" ;;
      --db-root-user)   shift; [ $# -gt 0 ] || usage_err '--db-root-user 后面要跟用户名'; DB_ROOT_USER="$1" ;;
      --db-root-pass)   shift; [ $# -gt 0 ] || usage_err '--db-root-pass 后面要跟密码'; DB_ROOT_PASS="$1"; DB_ROOT_PASS_GIVEN=1 ;;
      --repo)           shift; [ $# -gt 0 ] || usage_err '--repo 后面要跟 git 地址'; REPO_URL="$1" ;;
      --tarball)        shift; [ $# -gt 0 ] || usage_err '--tarball 后面要跟下载地址'; TARBALL_URL="$1" ;;
      --service)        shift; [ $# -gt 0 ] || usage_err '--service 后面要跟 auto/bt/pm2/systemd'; SERVICE_PREF="$1" ;;
      --ssl-email)      shift; [ $# -gt 0 ] || usage_err '--ssl-email 后面要跟邮箱'; SSL_EMAIL="$1" ;;
      --no-nginx)       NO_NGINX=1 ;;
      --no-ssl)         NO_SSL=1 ;;
      --uninstall)      UNINSTALL=1 ;;
      --yes|-y)         ASSUME_YES=1 ;;
      --dry-run)        DRY_RUN=1 ;;
      --verbose|-v)     VERBOSE=1 ;;
      --help|-h)        usage; exit 0 ;;
      --version)        printf 'wzbp install.sh %s\n' "$SCRIPT_VERSION"; exit 0 ;;
      *)                usage_err "未知参数：$1" ;;
    esac
    shift
  done
}

# 域名/目录/端口/库名的规范化与校验
normalize_and_validate() {
  # 环境变量兜底
  if [ -z "$REPO_URL" ] && [ -n "${WZBP_REPO:-}" ]; then REPO_URL="$WZBP_REPO"; fi

  # 默认目录：脚本所在目录（是项目目录时），否则 /www/wwwroot/wzbp
  if [ "$DIR_GIVEN" = 0 ]; then
    DIR=$(script_dir)
    if [ -f "$DIR/server/index.js" ] && [ -f "$DIR/index.html" ]; then
      : # 从项目目录运行，就地安装
    else
      DIR='/www/wwwroot/wzbp'
    fi
  fi
  # 去掉末尾斜杠、把反斜杠统一成正斜杠（方便在 Git Bash 下预演）
  DIR=$(printf '%s' "$DIR" | tr '\\' '/')
  case "$DIR" in
    */) DIR="${DIR%/}" ;;
  esac
  case "$DIR" in
    /*) ;;
    *) DIR="$(pwd)/${DIR}" ;;
  esac

  if [ "$UNINSTALL" = 1 ] && [ -z "$DOMAIN" ]; then
    # 卸载时允许从安装记录里读域名
    local st="${DIR}/${STATE_NAME}" d
    d=$(state_get "$st" WZBP_STATE_DOMAIN 2>/dev/null || true)
    [ -n "$d" ] && DOMAIN="$d"
  fi

  if [ -z "$DOMAIN" ]; then
    usage_err '缺少必填参数 --domain（站点域名，例如 --domain bp.example.com）'
  fi

  # 域名规范化：去掉协议头、路径、端口后段、末尾点
  DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN#https://}"
  case "$DOMAIN" in
    */*) DOMAIN="${DOMAIN%%/*}" ;;
  esac
  case "$DOMAIN" in
    *.) DOMAIN="${DOMAIN%.}" ;;
  esac
  case "$DOMAIN" in
    '') usage_err '--domain 不能为空' ;;
  esac
  case "$DOMAIN" in
    *[!A-Za-z0-9._:-]*) usage_err "--domain 含非法字符：$DOMAIN（只允许字母、数字、. - _ :）" ;;
  esac
  DOMAIN_IS_IP=0
  case "$DOMAIN" in
    *[A-Za-z]*) ;;
    *) DOMAIN_IS_IP=1 ;;
  esac

  check_port "$PORT" '--port'
  check_port "$DB_PORT" '--db-port'

  case "$DB_NAME" in
    *[!A-Za-z0-9_\$]*) die "数据库名不合法：$DB_NAME" "只允许字母、数字、下划线（服务端 server/config.js 也是这个白名单，否则会退回默认库名 wzbp）。" ;;
  esac
  [ -n "$DB_NAME" ] || die '数据库名不能为空' '用 --db-name 指定，例如 --db-name wzbp。'
  case "$DB_USER" in
    *[!A-Za-z0-9_\$]*) die "数据库用户名不合法：$DB_USER" '只允许字母、数字、下划线，例如 --db-user wzbp。' ;;
  esac
  [ -n "$DB_USER" ] || die '数据库用户名不能为空' '用 --db-user 指定，例如 --db-user wzbp。'

  case "$SERVICE_PREF" in
    auto|bt|pm2|systemd) ;;
    *) usage_err "--service 只支持 auto / bt / pm2 / systemd，收到：$SERVICE_PREF" ;;
  esac
}

check_port() {
  local p="$1" name="$2"
  case "$p" in
    ''|*[!0-9]*) usage_err "${name} 必须是数字，收到：$p" ;;
  esac
  if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then
    usage_err "${name} 超出范围（1-65535），收到：$p"
  fi
}

script_dir() {
  local src d
  src="${BASH_SOURCE[0]:-$0}"
  d=$(dirname "$src" 2>/dev/null) || d='.'
  (cd "$d" 2>/dev/null && pwd) || printf '%s' "$d"
}

# 读安装记录里的键
state_get() {
  local f="$1" k="$2"
  [ -f "$f" ] || return 1
  sed -n "s/^${k}=//p" "$f" 2>/dev/null | tail -n 1
}

# =============================================================================
#  环境检测
# =============================================================================
detect_os() {
  OS_KERNEL=$(uname -s 2>/dev/null || printf 'unknown')
  case "$OS_KERNEL" in
    Linux) IS_LINUX=1 ;;
    *) IS_LINUX=0 ;;
  esac
  if [ -f /etc/os-release ]; then
    DISTRO=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '"')
  fi
  [ -n "$DISTRO" ] || DISTRO=$(uname -sr 2>/dev/null || printf 'unknown')
}

detect_panel() {
  PANEL_OK=0
  [ -d /www/server/panel ] && PANEL_OK=1
}

detect_nginx() {
  local c
  NGINX_BIN=''
  for c in /www/server/nginx/sbin/nginx /usr/sbin/nginx /usr/local/nginx/sbin/nginx; do
    if [ -x "$c" ]; then NGINX_BIN="$c"; break; fi
  done
  if [ -z "$NGINX_BIN" ]; then NGINX_BIN=$(command -v nginx 2>/dev/null || true); fi

  NGINX_CONF_DIR=''
  if [ -d /www/server/panel/vhost/nginx ]; then
    NGINX_CONF_DIR='/www/server/panel/vhost/nginx'
  elif [ -d /www/server/nginx/conf/vhost ]; then
    NGINX_CONF_DIR='/www/server/nginx/conf/vhost'
  elif [ -d /etc/nginx/conf.d ]; then
    NGINX_CONF_DIR='/etc/nginx/conf.d'
  fi
}

detect_mysql() {
  local c
  MYSQL_BIN=''
  for c in /www/server/mysql/bin/mysql /usr/bin/mysql /usr/local/mysql/bin/mysql /usr/local/bin/mysql; do
    if [ -x "$c" ]; then MYSQL_BIN="$c"; break; fi
  done
  if [ -z "$MYSQL_BIN" ]; then MYSQL_BIN=$(command -v mysql 2>/dev/null || true); fi

  MYSQLD_OK=0
  [ -x /www/server/mysql/bin/mysqld ] && MYSQLD_OK=1
  [ -x /usr/sbin/mysqld ] && MYSQLD_OK=1
  [ -x /usr/sbin/mariadbd ] && MYSQLD_OK=1
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet mysqld 2>/dev/null && MYSQLD_OK=1
    systemctl is-active --quiet mysql 2>/dev/null && MYSQLD_OK=1
    systemctl is-active --quiet mariadb 2>/dev/null && MYSQLD_OK=1
  fi
}

node_major() {
  local v
  v=$("$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  case "$v" in
    ''|*[!0-9]*) printf '0' ;;
    *) printf '%s' "$v" ;;
  esac
}

detect_node() {
  local c nd v
  NODE_BIN=''
  NPM_BIN=''

  # 1) 宝塔 Node 版本管理器优先：/www/server/nodejs/vXX/bin/node（取版本号最大的一个）
  for c in /www/server/nodejs/v*/bin/node; do
    if [ -x "$c" ]; then
      v=$(node_major "$c")
      if [ "$v" -ge 18 ]; then NODE_BIN="$c"; fi
    fi
  done

  # 2) 系统里的 node
  if [ -z "$NODE_BIN" ]; then
    for c in /usr/local/bin/node /usr/bin/node; do
      if [ -x "$c" ] && [ "$(node_major "$c")" -ge 18 ]; then NODE_BIN="$c"; break; fi
    done
  fi
  if [ -z "$NODE_BIN" ]; then
    c=$(command -v node 2>/dev/null || true)
    if [ -n "$c" ] && [ "$(node_major "$c")" -ge 18 ]; then NODE_BIN="$c"; fi
  fi

  if [ -n "$NODE_BIN" ]; then
    nd=$(dirname "$NODE_BIN")
    if [ -x "$nd/npm" ]; then NPM_BIN="$nd/npm"; fi
    if [ -z "$NPM_BIN" ]; then NPM_BIN=$(command -v npm 2>/dev/null || true); fi
  fi
}

detect_run_user() {
  if id www >/dev/null 2>&1; then RUN_USER='www'; else RUN_USER='root'; fi
  RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null || printf '%s' "$RUN_USER")
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

# 宝塔 Node 项目的登记信息（不同版本位置不同，只做「存在性探测」，不改宝塔数据库）
bt_project_registered() {
  local f
  for f in /www/server/panel/vhost/nodejs /www/server/panel/data/nodejs_project.json \
           /www/server/nodejs/vhost /www/server/panel/plugin/nodejs; do
    [ -e "$f" ] || continue
    if grep -rqsF -- "$DIR" "$f" 2>/dev/null; then return 0; fi
  done
  return 1
}

# 宝塔面板里保存的 MySQL root 密码（尽力而为，找不到就返回 1）
mysql_root_pass_from_panel() {
  local f v
  for f in /www/server/panel/config/mysql.json /www/server/panel/data/mysql_root.pl \
           /www/server/panel/data/default.pl; do
    [ -f "$f" ] || continue
    if [ "${f##*.}" = 'json' ]; then
      v=$(tr ',{}' '\n\n\n' < "$f" 2>/dev/null | sed -n 's/.*"mysql_root"[ ]*:[ ]*"\([^"]*\)".*/\1/p' | head -n 1)
      [ -z "$v" ] && v=$(tr ',{}' '\n\n\n' < "$f" 2>/dev/null | sed -n 's/.*"root"[ ]*:[ ]*"\([^"]*\)".*/\1/p' | head -n 1)
    else
      v=$(head -n 1 "$f" 2>/dev/null | tr -d '\r\n')
    fi
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  done
  return 1
}

# =============================================================================
#  步骤 1：环境自检
# =============================================================================
step_env_check() {
  step '环境自检（root / 宝塔 / Nginx / MySQL / Node）'

  detect_os
  detect_panel
  detect_nginx
  detect_mysql
  detect_node
  detect_run_user

  local uid
  uid=$(id -u 2>/dev/null || printf '?')
  if [ "$uid" = '0' ]; then
    ok "以 root 运行（UID=0）"
  elif dry; then
    warn "当前不是 root（UID=${uid}）—— --dry-run 只打印不执行，不阻断"
  else
    die "必须以 root 运行（当前 UID=${uid}）" "用 sudo 重新执行：sudo bash install.sh --domain ${DOMAIN}"
  fi

  if [ "$IS_LINUX" = 1 ]; then
    ok "操作系统：${DISTRO}（内核 ${OS_KERNEL}）"
  elif dry; then
    warn "当前系统不是 Linux（${OS_KERNEL}）—— --dry-run 仅演练流程，正式安装请在 Linux 上跑"
  else
    die "本脚本只支持 Linux（当前 ${OS_KERNEL}）" '请在宝塔 Linux 服务器上运行；Windows/macOS 可用 --dry-run 预演。'
  fi

  if [ "$PANEL_OK" = 1 ]; then
    ok '检测到宝塔面板（/www/server/panel）'
  else
    warn '未检测到宝塔面板（/www/server/panel 不存在）——将尝试用系统命令安装，Nginx 配置放到 /etc/nginx/conf.d'
    if dry; then dim '  dry-run：正式安装时会继续尝试，不会直接退出'; fi
  fi

  if [ -n "$NGINX_BIN" ]; then
    ok "Nginx 已就绪：${NGINX_BIN}"
    if [ -n "$NGINX_CONF_DIR" ]; then ok "Nginx 配置目录：${NGINX_CONF_DIR}"; fi
  else
    warn '没找到 nginx（教程 §2：宝塔软件商店装 Nginx 1.24+）'
  fi

  if [ -n "$MYSQL_BIN" ]; then
    ok "MySQL 客户端已就绪：${MYSQL_BIN}"
    if [ "$MYSQLD_OK" = 1 ]; then ok 'MySQL 服务在运行'; else warn 'MySQL 客户端在，但没检测到 mysqld 在运行（教程 §2）'; fi
  else
    warn '没找到 mysql 客户端（教程 §2：宝塔软件商店装 MySQL 5.7 / 8.0）'
  fi

  if [ -n "$NODE_BIN" ]; then
    ok "Node 已就绪：${NODE_BIN}（$("$NODE_BIN" -v 2>/dev/null)）"
    if [ -n "$NPM_BIN" ]; then ok "npm：${NPM_BIN}"; else warn '没找到 npm，第 5 步会失败'; fi
  else
    warn '没找到 Node 18+（教程 §2：宝塔「Node.js 版本管理器」装 18/20 LTS）'
    if dry; then
      dim '  dry-run：正式安装时会尝试自动安装，装不上就用非零退出并给出提示'
    else
      try_install_node || die "缺少 Node.js 18+，自动安装也没成功" "宝塔面板 → 软件商店 → 搜「Node」→ 装 Node.js 版本管理器 → 再装 18 或 20 LTS；装完重跑本脚本。"
    fi
  fi

  say ''
  local plan_nginx plan_ssl
  if [ "$NO_NGINX" = 1 ]; then plan_nginx='跳过（--no-nginx）'; else plan_nginx="${NGINX_CONF_DIR:-自动探测}"; fi
  if [ "$NO_SSL" = 1 ]; then plan_ssl='跳过（--no-ssl）'; else plan_ssl="尝试 Let's Encrypt（失败不阻断）"; fi
  info '安装计划：'
  printf '%s\n' "    站点域名：${DOMAIN}（IP=$([ "$DOMAIN_IS_IP" = 1 ] && printf '是，HTTPS 会自动跳过' || printf '否')）"
  printf '%s\n' "    站点目录：${DIR}"
  printf '%s\n' "    Node 端口：${PORT}（只监听 127.0.0.1）"
  printf '%s\n' "    数据库：${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  printf '%s\n' "    运行用户：${RUN_USER}"
  printf '%s\n' "    Nginx：${plan_nginx}"
  printf '%s\n' "    HTTPS：${plan_ssl}"
  say ''
  confirm "确认按上面的计划安装？"
}

# 尽力自动装 Node（宝塔 Node 管理器优先，其次系统包管理器）
try_install_node() {
  local pm
  if [ -d /www/server/nodejs ]; then
    warn '宝塔 Node 版本管理器目录存在，但里面没有 18+ 的 Node'
    dim '  请在宝塔面板 → 软件商店 → Node.js 版本管理器里安装 18 或 20 LTS，然后重跑本脚本'
    return 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    info '尝试用 apt-get 安装 nodejs（可能装到的版本较老）'
    run 'apt-get update' apt-get update -qq || true
    run 'apt-get install -y nodejs npm' apt-get install -y nodejs npm || return 1
  elif command -v yum >/dev/null 2>&1; then
    info '尝试用 yum 安装 nodejs'
    run 'yum install -y nodejs npm' yum install -y nodejs npm || return 1
  elif command -v dnf >/dev/null 2>&1; then
    info '尝试用 dnf 安装 nodejs'
    run 'dnf install -y nodejs npm' dnf install -y nodejs npm || return 1
  else
    warn '没有可用的包管理器（apt/yum/dnf）'
    return 1
  fi
  detect_node
  [ -n "$NODE_BIN" ] || return 1
  return 0
}

# =============================================================================
#  步骤 2：站点目录与项目文件
# =============================================================================
step_prepare_dir() {
  step '准备站点目录与项目文件（教程 §3）'

  mkp "$DIR"

  if [ -f "$DIR/server/index.js" ] && [ -f "$DIR/index.html" ]; then
    ok "项目文件已就位：${DIR}"
  else
    acquire_sources
  fi

  # 关键目录自检（教程 §3 强调 data/ 与 vendor/ 别漏）
  local missing=''
  [ -f "$DIR/index.html" ] || missing="${missing} index.html"
  [ -f "$DIR/overlay.html" ] || missing="${missing} overlay.html"
  [ -d "$DIR/data" ] || missing="${missing} data/"
  [ -d "$DIR/vendor" ] || missing="${missing} vendor/"
  [ -f "$DIR/package.json" ] || missing="${missing} package.json"
  [ -f "$DIR/server/index.js" ] || missing="${missing} server/index.js"
  [ -f "$DIR/server/schema.sql" ] || missing="${missing} server/schema.sql"
  if [ -n "$missing" ]; then
    if dry; then
      warn "dry-run 下未校验到的文件（本机没有这些文件是正常的）：${missing}"
    else
      die "项目文件不完整，缺少：${missing}" "重新完整上传/拉取项目：data/（英雄数据）和 vendor/（html2canvas）最容易漏（教程 §3 与 Q5/Q6）。"
    fi
  else
    ok '关键文件齐全（index.html / overlay.html / data/ / vendor/ / server/）'
  fi

  chown_tree "$DIR"
  chmod_tree "$DIR"
  ok "站点目录权限已处理（${RUN_USER}:${RUN_GROUP}，755）"
}

acquire_sources() {
  if [ -n "$REPO_URL" ]; then
    info "从 git 仓库拉取项目：${REPO_URL} → ${DIR}"
    if dry; then
      printf '  %s[dry-run]%s 创建临时目录 → git clone --depth 1 %s <临时目录> → 复制到 %s\n' "$C_DIM" "$C_R" "$REPO_URL" "$DIR"
    else
      local tmp
      tmp=$(mktemp -d 2>/dev/null) || die '无法创建临时目录（mktemp 失败）' '检查 /tmp 是否可写、磁盘是否已满。'
      if ! run "git clone --depth 1 ${REPO_URL}" git clone --depth 1 "$REPO_URL" "$tmp/src"; then
        rm -rf "$tmp"
        die "git clone 失败：${REPO_URL}" '检查仓库地址/网络；没有 git 就改用 --tarball 或先手动上传项目文件（教程 §3）。'
      fi
      mkdir -p "$DIR"
      cp -R "$tmp/src/." "$DIR/" 2>/dev/null || { rm -rf "$tmp"; die "复制项目文件失败：${tmp}/src → ${DIR}" '检查磁盘空间与权限。'; }
      rm -rf "$tmp"
      ok "项目文件已就位：${DIR}"
    fi
    return 0
  fi

  if [ -n "$TARBALL_URL" ]; then
    info "下载项目包：${TARBALL_URL} → ${DIR}"
    if dry; then
      printf '  %s[dry-run]%s curl -fsSL %s -o <临时包> → tar xzf 到 %s\n' "$C_DIM" "$C_R" "$TARBALL_URL" "$DIR"
    else
      local tmp
      tmp=$(mktemp -d 2>/dev/null) || die '无法创建临时目录（mktemp 失败）' '检查 /tmp 是否可写。'
      if ! run "curl -fsSL ${TARBALL_URL}" curl -fsSL "$TARBALL_URL" -o "$tmp/wzbp.tar.gz"; then
        rm -rf "$tmp"
        die "下载失败：${TARBALL_URL}" '检查地址与网络；也可以手动下载上传后在本目录运行脚本（教程 §3）。'
      fi
      mkdir -p "$DIR"
      if ! run 'tar xzf' tar xzf "$tmp/wzbp.tar.gz" -C "$DIR" --strip-components=1; then
        rm -rf "$tmp"
        die '解压失败（tar 报错）' '确认下载的是 .tar.gz 包且结构是仓库根目录直接在里面。'
      fi
      rm -rf "$tmp"
      ok "项目文件已就位：${DIR}"
    fi
    return 0
  fi

  if dry; then
    warn '本地没有项目文件（本机是 Windows 开发机，属正常），dry-run 继续演练后续步骤'
    dim "  正式安装时若目录里没有项目文件，需要：① 在项目目录里运行；② 加 --repo <git 地址>；③ 加 --tarball <tar.gz 地址>"
    return 0
  fi

  die "目录 ${DIR} 里没有项目文件" \
      "三种修法任选：① cd 进项目目录再运行（git clone <仓库> wzbp && cd wzbp && sudo bash install.sh --domain ${DOMAIN}）；② 加 --repo <git 仓库地址> 让脚本自动拉取；③ 加 --tarball <tar.gz 下载地址>，或手动上传项目文件到 ${DIR}（教程 §3）。"
}

# =============================================================================
#  步骤 3：数据库
# =============================================================================
mysql_do() { # mysql_do <admin|app> <描述> <SQL（用 __WZBP_DB_PASSWORD__ 代表密码）>
  local role="$1" desc="$2" sql="$3" u p real_sql rc
  if [ "$role" = 'admin' ]; then u="$DB_ROOT_USER"; p="$DB_ROOT_PASS"; else u="$DB_USER"; p="$DB_PASS"; fi
  real_sql=${sql//__WZBP_DB_PASSWORD__/$p}

  if dry; then
    printf '  %s[dry-run]%s MySQL（%s）：%s\n' "$C_DIM" "$C_R" "$role" "$desc"
    printf '            $ mysql -h%s -P%s -u%s -p****** -e %s\n' "$DB_HOST" "$DB_PORT" "$u" "$(printf '%q' "$sql")"
    LAST_OUT=''
    return 0
  fi

  if [ -z "$MYSQL_BIN" ]; then
    LAST_OUT='找不到 mysql 客户端'
    return 1
  fi
  LAST_OUT=$(MYSQL_PWD="$p" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$u" \
             --connect-timeout=5 --default-character-set=utf8mb4 -N -B -e "$real_sql" 2>&1)
  rc=$?
  return "$rc"
}

mysql_can_connect() { # mysql_can_connect admin|app
  local role="$1" u p rc
  if [ "$role" = 'admin' ]; then u="$DB_ROOT_USER"; p="$DB_ROOT_PASS"; else u="$DB_USER"; p="$DB_PASS"; fi
  if dry; then
    printf '  %s[dry-run]%s 探测 MySQL 连接（%s：-h%s -P%s -u%s）\n' "$C_DIM" "$C_R" "$role" "$DB_HOST" "$DB_PORT" "$u"
    case "$role" in admin) return 0 ;; *) return 1 ;; esac
  fi
  [ -n "$MYSQL_BIN" ] || return 1
  MYSQL_PWD="$p" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$u" --connect-timeout=5 -N -B -e 'SELECT 1' >/dev/null 2>&1
  rc=$?
  return "$rc"
}

sql_escape() { # 转义 MySQL 字符串字面量
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"
}

gen_password() {
  local p=''
  if command -v openssl >/dev/null 2>&1; then
    p=$(openssl rand -base64 32 2>/dev/null | tr -dc 'A-Za-z0-9' | cut -c1-24)
  fi
  if [ -z "$p" ] && [ -r /dev/urandom ]; then
    p=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 24)
  fi
  if [ -z "$p" ]; then
    # 最后兜底：用时间和进程号拼一个（强度略低）
    p="wzbp$(date +%s)$(printf '%s' "$$")"
  fi
  printf '%s' "$p"
}

step_database() {
  step '建数据库与数据库用户（教程 §4；表由服务自己建，不导 schema.sql）'

  if [ "$DB_PASS_GIVEN" = 1 ] && [ -n "$DB_PASS" ]; then
    ok '使用 --db-pass 提供的密码'
  else
    if dry; then
      DB_PASS='__WZBP_GENERATED__'
      ok '将自动生成 24 位随机强密码（dry-run 不生成真实值）'
    else
      DB_PASS=$(gen_password)
      ok '已自动生成 24 位随机强密码（写入 .env）'
    fi
  fi

  # 管理员密码：参数 > 宝塔配置 > 交互询问
  if [ "$DB_ROOT_PASS_GIVEN" = 0 ]; then
    local found
    found=$(mysql_root_pass_from_panel 2>/dev/null || true)
    if [ -n "$found" ]; then
      DB_ROOT_PASS="$found"
      ok '已从宝塔配置里读到 MySQL root 密码'
    elif dry; then
      DB_ROOT_PASS='__FROM_PANEL_OR_PROMPT__'
      dim '  dry-run：正式安装时会先找宝塔保存的 root 密码，找不到就交互询问（或要求 --db-root-pass）'
    else
      if [ ! -t 0 ]; then
        die '不知道 MySQL 管理员密码（非交互环境）' "加参数 --db-root-pass '<root密码>' 重跑；或在宝塔面板 → 数据库 → root 密码 里查看。"
      fi
      printf '%s\n' '请输入 MySQL 管理员密码（宝塔面板 → 数据库 → root 密码；输入不回显）：'
      printf 'root 密码: '
      local rp=''
      read -r -s rp || rp=''
      printf '\n'
      [ -n "$rp" ] || die '没有提供 MySQL 管理员密码' "用 --db-root-pass '<root密码>' 重跑。"
      DB_ROOT_PASS="$rp"
    fi
  fi

  # 幂等：如果目标用户已经能连上、库也在，就不用管理员账号
  local need_admin=1
  if [ "$DB_ROOT_PASS_GIVEN" = 0 ] && ! dry; then
    if [ -n "$MYSQL_BIN" ] && MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
         --connect-timeout=5 -N -B -e "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${DB_NAME}'" 2>/dev/null | grep -qx "$DB_NAME"; then
      need_admin=0
      ok "数据库 ${DB_NAME} 与用户 ${DB_USER} 已存在且能连上，跳过建库建用户（幂等）"
    fi
  fi
  if dry; then
    dim '  dry-run：正式安装时会先试一下目标库/用户是否已存在，存在就跳过（幂等），不存在才用管理员账号建'
  fi

  if [ "$need_admin" = 1 ]; then
    if ! mysql_can_connect admin; then
      if dry; then
        warn 'dry-run：本机没有 MySQL，跳过真实连接探测'
      else
        die "用 ${DB_ROOT_USER}@${DB_HOST}:${DB_PORT} 连不上 MySQL" \
            "检查：① 宝塔面板 → 软件商店 → MySQL 是否「运行中」；② 密码对不对（宝塔 → 数据库 → root 密码，或用 --db-root-pass 指定）；③ 端口是否为 ${DB_PORT}。"
      fi
    fi

    local esc_pass esc_name esc_user
    esc_pass=$(sql_escape "$DB_PASS")
    esc_name=$(sql_escape "$DB_NAME")
    esc_user=$(sql_escape "$DB_USER")

    # 库：只建不删（教程 §4；表结构由服务首启自动创建）
    mysql_do admin "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`（utf8mb4）" \
      "CREATE DATABASE IF NOT EXISTS \`${esc_name}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;" \
      || die "建库失败：${DB_NAME}" "确认管理员账号有 CREATE 权限；宝塔面板 → 数据库 里也可以手动添加同名库。"

    # 用户：localhost（socket）与 127.0.0.1（TCP）都要有，服务是用 TCP 连的
    local hostlist='localhost 127.0.0.1'
    case "$DB_HOST" in
      127.0.0.1|localhost|'') ;;
      *) hostlist="${hostlist} %"; warn "数据库不在本机（${DB_HOST}），用户会额外授权给 %（允许任意来源），请自行收紧" ;;
    esac

    local h
    for h in $hostlist; do
      mysql_do admin "CREATE USER IF NOT EXISTS '${DB_USER}'@'${h}' + 授权 ${DB_NAME}.* + 同步密码" \
        "CREATE USER IF NOT EXISTS '${esc_user}'@'${h}' IDENTIFIED BY '__WZBP_DB_PASSWORD__';" \
        || warn "创建用户 '${DB_USER}'@'${h}' 失败（可能已存在，继续）"
      mysql_do admin "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'${h}'" \
        "GRANT ALL PRIVILEGES ON \`${esc_name}\`.* TO '${esc_user}'@'${h}';" \
        || warn "授权 '${DB_USER}'@'${h}' 失败（继续，最后会用连接测试判定）"
      mysql_do admin "ALTER USER '${DB_USER}'@'${h}' 同步密码" \
        "ALTER USER '${esc_user}'@'${h}' IDENTIFIED BY '__WZBP_DB_PASSWORD__';" \
        || dim "  （ALTER USER 失败：MySQL/MariaDB 版本差异，若密码本来就是对的可以忽略）"
    done
    mysql_do admin 'FLUSH PRIVILEGES' 'FLUSH PRIVILEGES;' || true
    ok "数据库与用户已就绪：${DB_NAME} / ${DB_USER}"
  fi

  # 用应用账号验证一次（服务就是用它连的）
  if dry; then
    printf '  %s[dry-run]%s 用应用账号验证连接：mysql -h%s -P%s -u%s -p****** -e "SELECT 1"\n' "$C_DIM" "$C_R" "$DB_HOST" "$DB_PORT" "$DB_USER"
  else
    if ! mysql_can_connect app; then
      die "用应用账号 ${DB_USER}@${DB_HOST}:${DB_PORT} 连接失败" \
          "① 密码是否与 .env 一致；② 宝塔面板 → 数据库 → 该用户权限是否「本地服务器」；③ 手动验证：mysql -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p（教程 §11 Q1）。"
    fi
    ok '应用账号连接测试通过'
  fi
}

# =============================================================================
#  步骤 4：.env
# =============================================================================
env_escape() { # systemd EnvironmentFile 与 POSIX shell source 都能吃：双引号 + 反斜杠转义
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g' -e 's/`/\\`/g'
}

render_env() {
  local pass_display port_display
  if dry; then
    pass_display='<安装时写入：随机生成的强密码，或用 --db-pass 提供的值>'
    port_display="$PORT"
  else
    pass_display="$(env_escape "$DB_PASS")"
    port_display="$PORT"
  fi
  cat <<EOF
# wzbp · 王者荣耀 BP 展示台 —— 运行时环境变量（由 install.sh 生成，chmod 600）
# 服务端 server/config.js 只读这些环境变量；这个文件已被 .gitignore 忽略，别提交。
#
# 手动试跑（教程 §5）：
#   cd ${DIR} && set -a && . ./.env && set +a && node server/index.js
# 注意：服务只监听 127.0.0.1，外网访问走 Nginx 反代（教程 §7）。

WZBP_PORT=${port_display}
WZBP_DB_HOST="${DB_HOST}"
WZBP_DB_PORT=${DB_PORT}
WZBP_DB_USER="$(env_escape "$DB_USER")"
WZBP_DB_PASSWORD="${pass_display}"
WZBP_DB_NAME="$(env_escape "$DB_NAME")"
EOF
}

step_env_file() {
  step '写入 .env 环境变量（教程 §5 / §6）'

  render_env | write_file "${DIR}/${ENV_NAME}" '.env：WZBP_PORT / WZBP_DB_* 六个变量（含数据库密码，chmod 600）'
  chmod_ 600 "${DIR}/${ENV_NAME}"
  chown_tree "${DIR}/${ENV_NAME}"
  ok '密码只落在 .env，不写进任何会被 git 跟踪的文件'

  # 确保 .env 被 .gitignore 忽略（幂等：已有规则就不动）
  local gi="${DIR}/.gitignore"
  if [ -f "$gi" ] && grep -qE '^\.env$|^\.env\.\*$|^\.env\.' "$gi" 2>/dev/null; then
    ok '.gitignore 已经忽略 .env，无需改动'
  elif dry; then
    printf '  %s[dry-run]%s 向 %s 追加一行 ".env"\n' "$C_DIM" "$C_R" "$gi"
  else
    if printf '\n# wzbp install.sh：数据库密码，禁止提交\n.env\n' >> "$gi" 2>/dev/null; then
      ok '已把 .env 追加进 .gitignore'
    else
      warn "无法写入 ${gi}，请手动加一行 .env（否则可能误提交密码）"
    fi
  fi
}

# 安装记录（不含密码），卸载时用
render_state() {
  local conf=''
  [ "$NO_NGINX" = 1 ] || conf=$(nginx_conf_path_for_domain "$DOMAIN")
  cat <<EOF
# wzbp 安装记录（由 install.sh 生成；不含任何密码；已被 .gitignore 忽略）
WZBP_STATE_VERSION=${SCRIPT_VERSION}
WZBP_STATE_DOMAIN=${DOMAIN}
WZBP_STATE_DIR=${DIR}
WZBP_STATE_PORT=${PORT}
WZBP_STATE_DB_NAME=${DB_NAME}
WZBP_STATE_DB_USER=${DB_USER}
WZBP_STATE_DB_HOST=${DB_HOST}
WZBP_STATE_DB_PORT=${DB_PORT}
WZBP_STATE_SERVICE=${ENGINE}
WZBP_STATE_NGINX_CONF=${conf}
WZBP_STATE_RUN_USER=${RUN_USER}
EOF
}

write_state() {
  render_state | write_file "${DIR}/${STATE_NAME}" '安装记录（卸载时读取；不含密码）'
}

# =============================================================================
#  步骤 5：依赖
# =============================================================================
step_deps() {
  step '安装 Node 依赖（教程 §5：npm install --omit=dev）'

  if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
    if dry; then
      warn 'dry-run：本机没有 Node/npm，跳过真实安装（正式安装第 1 步会先保证 Node 就绪）'
      printf '  %s[dry-run]%s cd %s && npm install --omit=dev --no-audit --no-fund\n' "$C_DIM" "$C_R" "$DIR"
      return 0
    fi
    die 'Node 或 npm 不可用，无法安装依赖' '先装 Node 18+（宝塔 → 软件商店 → Node.js 版本管理器），然后重跑。'
  fi

  local nd
  nd=$(dirname "$NODE_BIN")
  export PATH="${nd}:${PATH}"

  if run_in_dir "$DIR" "npm install --omit=dev --no-audit --no-fund" "$NPM_BIN" install --omit=dev --no-audit --no-fund; then
    ok '依赖安装完成（mysql2）'
  else
    die 'npm install 失败' "① 网络是否通（可试 npm config set registry https://registry.npmmirror.com）；② 手动进 ${DIR} 跑 npm install --omit=dev 看完整报错；③ 磁盘是否已满。"
  fi
  if [ ! -d "$DIR/node_modules/mysql2" ]; then
    if dry; then
      dim '  dry-run：未检查 node_modules/mysql2（本机没装）'
    else
      die '装完没找到 node_modules/mysql2' "手动执行：cd ${DIR} && ${NPM_BIN} install --omit=dev"
    fi
  else
    ok 'mysql2 已就位'
  fi
}

# =============================================================================
#  步骤 6：常驻服务
# =============================================================================
choose_engine() {
  ENGINE=''
  case "$SERVICE_PREF" in
    bt)      ENGINE='bt'; return 0 ;;
    pm2)     ENGINE='pm2'; return 0 ;;
    systemd) ENGINE='systemd'; return 0 ;;
  esac
  if bt_project_registered; then ENGINE='bt'; return 0; fi
  if command -v pm2 >/dev/null 2>&1; then ENGINE='pm2'; return 0; fi
  if systemd_available; then ENGINE='systemd'; return 0; fi
  ENGINE=''
  return 1
}

render_bt_script() {
  cat <<EOF
#!/bin/bash
# =============================================================================
# 由 wzbp install.sh 生成：宝塔「Node 项目」启动脚本
# 宝塔面板 → 网站 → Node 项目 → 添加：
#   项目名称 wzbp / 项目目录 ${DIR} / 启动文件 ${BT_RUN_NAME}
#   （启动方式选「自定义命令」或直接把这个文件当启动文件）
#   环境变量面板里逐条填 .env 里的 6 条（面板不会自动读 .env）
# =============================================================================
cd "${DIR}" || exit 1
[ -f .env ] && set -a && . ./.env && set +a
exec "${NODE_BIN:-node}" server/index.js
EOF
}

render_systemd_unit() {
  cat <<EOF
[Unit]
Description=wzbp 王者荣耀 BP 展示台（Node 服务，只监听 127.0.0.1:${PORT}）
Documentation=file:${DIR}/docs/宝塔部署教程.md
After=network-online.target mysqld.service mysql.service mariadb.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory="${DIR}"
EnvironmentFile=-${DIR}/${ENV_NAME}
ExecStart="${NODE_BIN}" server/index.js
Restart=always
RestartSec=3
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
}

render_pm2_json() {
  cat <<EOF
{
  "apps": [
    {
      "name": "${SERVICE_NAME}",
      "script": "server/index.js",
      "cwd": "${DIR}",
      "exec_interpreter": "${NODE_BIN}",
      "env_file": "${DIR}/${ENV_NAME}",
      "autorestart": true,
      "max_restarts": 20,
      "restart_delay": 3000,
      "out_file": "/var/log/wzbp-out.log",
      "error_file": "/var/log/wzbp-error.log",
      "merge_logs": true,
      "time": true
    }
  ]
}
EOF
}

step_service() {
  step '常驻运行 Node 服务（教程 §6）'

  local chosen=0
  if choose_engine; then chosen=1; fi
  if [ "$chosen" = 0 ]; then
    if dry; then
      ENGINE='systemd'
      warn 'dry-run：本机检测不到 宝塔 Node 项目 / pm2 / systemd，按最常见的 systemd 方案演示'
      dim '  正式安装的选择顺序：宝塔 Node 项目（已登记）→ pm2（已装）→ systemd（可用）→ 自动装 pm2'
    else
      chosen=1
      ENGINE='pm2'
    fi
  fi

  # 宝塔 Node 管理器存在时，顺手写好面板要用的启动脚本
  if [ -d /www/server/nodejs ] || dry; then
    mkp '/www/server/nodejs/vhost/scripts'
    render_bt_script | write_file "/www/server/nodejs/vhost/scripts/${BT_RUN_NAME}" '宝塔 Node 项目启动脚本（source .env 后启动 server/index.js）'
    chmod_ 755 "/www/server/nodejs/vhost/scripts/${BT_RUN_NAME}"
  fi

  case "$ENGINE" in
    bt)
      info '常驻方式：宝塔「Node 项目」（检测到该项目已登记，由面板守护进程保活）'
      if bt_project_registered; then
        ok '面板里已经登记过这个项目，直接重启它'
      else
        warn '面板里还没登记这个项目，请手动加一次（加完就是常驻，面板会自动保活）：'
        printf '%s\n' '    宝塔面板 → 网站 → Node 项目 → 添加 Node 项目'
        printf '%s\n' "      项目名称：${SERVICE_NAME}"
        printf '%s\n' "      项目目录：${DIR}"
        printf '%s\n' "      启动文件：${BT_RUN_NAME}（或 server/index.js）"
        printf '%s\n' "      项目端口：${PORT}（提示放行端口时选「不放行」，外网走 Nginx）"
        printf '%s\n' "      运行用户：${RUN_USER}；守护进程：勾上"
        printf '%s\n' "      环境变量：按 ${DIR}/${ENV_NAME} 里 6 条逐条填（面板不读 .env）"
        if ! dry; then
          die '宝塔 Node 项目尚未登记' "按上面 6 行在面板里加一次项目，然后重跑本脚本（本步会检测到并自动重启）；不想手点就改用 --service pm2 或 --service systemd。"
        fi
      fi
      if dry; then
        printf '  %s[dry-run]%s pkill -f "server/index.js"（面板守护会自动拉起）\n' "$C_DIM" "$C_R"
      else
        run 'pkill -f server/index.js（面板守护会重新拉起）' pkill -f 'server/index.js' || true
        sleep 2
      fi
      ;;
    pm2)
      info '常驻方式：pm2'
      if ! command -v pm2 >/dev/null 2>&1; then
        if dry; then
          printf '  %s[dry-run]%s npm install -g pm2\n' "$C_DIM" "$C_R"
        else
          run 'npm install -g pm2' "$NPM_BIN" install -g pm2 --no-audit --no-fund \
            || die 'pm2 安装失败' "改用 systemd：加 --service systemd 重跑；或宝塔 → 软件商店 → PM2 管理器。"
        fi
      fi
      render_pm2_json | write_file "${DIR}/${PM2_NAME}" 'pm2 配置（env_file 指向 .env，密码不落在这里）'
      if dry; then
        printf '  %s[dry-run]%s set -a; . %s/.env; set +a; pm2 start %s/%s --update-env; pm2 save\n' "$C_DIM" "$C_R" "$DIR" "$DIR" "$PM2_NAME"
        printf '  %s[dry-run]%s pm2 startup systemd（开机自启，root 身份）\n' "$C_DIM" "$C_R"
      else
        ( set -a; . "${DIR}/${ENV_NAME}"; set +a
          pm2 start "${DIR}/${PM2_NAME}" --update-env --cwd "$DIR" ) \
          || die 'pm2 启动失败' "看日志：pm2 logs ${SERVICE_NAME} --lines 50；常见原因是数据库连不上（教程 §11 Q1）。"
        run 'pm2 save' pm2 save || warn 'pm2 save 失败，重启机器后不会自动恢复'
        run 'pm2 startup systemd' pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || \
          warn 'pm2 startup 失败（开机自启没配上，可稍后手动执行 pm2 startup）'
        ok 'pm2 已启动并保存'
      fi
      ;;
    systemd)
      info '常驻方式：systemd（wzbp.service）'
      render_systemd_unit | write_file "/etc/systemd/system/${SERVICE_NAME}.service" 'systemd 单元（EnvironmentFile 指向 .env，密码不落在单元里）'
      if dry; then
        printf '  %s[dry-run]%s systemctl daemon-reload; systemctl enable --now %s\n' "$C_DIM" "$C_R" "$SERVICE_NAME"
      else
        run 'systemctl daemon-reload' systemctl daemon-reload || die 'systemctl daemon-reload 失败' '检查 /etc/systemd/system 是否可写。'
        run "systemctl enable --now ${SERVICE_NAME}" systemctl enable --now "$SERVICE_NAME" \
          || die "systemd 启动 ${SERVICE_NAME} 失败" "看详情：systemctl status ${SERVICE_NAME} -l --no-pager；journalctl -u ${SERVICE_NAME} -n 50。"
        ok 'systemd 服务已启动并设为开机自启'
      fi
      ;;
  esac

  # 二次确认服务真的在监听
  if dry; then
    printf '  %s[dry-run]%s ss -lnt | grep 127.0.0.1:%s（确认服务只在 127.0.0.1 监听）\n' "$C_DIM" "$C_R" "$PORT"
  else
    local i=0
    while [ "$i" -lt 10 ]; do
      if command -v ss >/dev/null 2>&1; then
        if ss -lnt 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then ok "端口 ${PORT} 已在监听（127.0.0.1）"; break; fi
      elif command -v netstat >/dev/null 2>&1; then
        if netstat -lnt 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then ok "端口 ${PORT} 已在监听（127.0.0.1）"; break; fi
      else
        break
      fi
      sleep 1
      i=$((i + 1))
    done
    [ "$i" -ge 10 ] && warn "10 秒内没看到端口 ${PORT}，第 8 步会做健康检查并给排错命令"
  fi

  write_state
}

# =============================================================================
#  步骤 7：Nginx
# =============================================================================
render_nginx_conf() {
  local log_lines=''
  if [ -d /www/wwwlogs ]; then
    log_lines="
    access_log /www/wwwlogs/${DOMAIN}.log;
    error_log  /www/wwwlogs/${DOMAIN}.error.log;"
  fi
  cat <<EOF
# =============================================================================
#  wzbp · 王者荣耀 BP 展示台 —— 站点配置
#  由 install.sh 自动生成（幂等：重复安装会整块覆盖本文件，改动前已备份 .bak.*）
#  站点目录：${DIR}
#  后端节点：http://127.0.0.1:${PORT}（只监听本机，8787 不要对公网放行）
# =============================================================================

server {
    listen 80;
    server_name ${DOMAIN};

    root ${DIR};
    index index.html;${log_lines}

    # ---------- 静态文件：前端页面 ----------
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # index.html 不缓存，更新后能立刻看到「房间」入口
    location = /index.html {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # ---------- 后端 API + SSE 实时推送（教程 §7.2 的关键配置） ----------
    location /api/ {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # ↓↓↓ 让 SSE 实时推送生效的关键几行（少了会「别人选完我这边不动」）↓↓↓
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding off;
    }

    # 隐藏文件不给看
    location ~ /\\.(?!well-known) {
        deny all;
    }
}
EOF
}

nginx_conf_path_for_domain() {
  local d="$1"
  if [ -n "$NGINX_CONF_DIR" ]; then
    case "$NGINX_CONF_DIR" in
      */vhost/nginx|*/conf/vhost) printf '%s/%s.conf' "$NGINX_CONF_DIR" "$d" ;;
      *) printf '%s/wzbp-%s.conf' "$NGINX_CONF_DIR" "$d" ;;
    esac
  else
    printf '/www/server/panel/vhost/nginx/%s.conf' "$d"
  fi
}

nginx_test() {
  if dry; then
    printf '  %s[dry-run]%s %s -t（校验配置，失败会回滚）\n' "$C_DIM" "$C_R" "${NGINX_BIN:-nginx}"
    return 0
  fi
  [ -n "$NGINX_BIN" ] || return 1
  "$NGINX_BIN" -t >/dev/null 2>&1
}

nginx_reload() {
  if dry; then
    printf '  %s[dry-run]%s %s -s reload\n' "$C_DIM" "$C_R" "${NGINX_BIN:-nginx}"
    return 0
  fi
  if [ -n "$NGINX_BIN" ]; then
    "$NGINX_BIN" -s reload >/dev/null 2>&1 && return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl reload nginx >/dev/null 2>&1 && return 0
    systemctl reload nginx.service >/dev/null 2>&1 && return 0
  fi
  return 1
}

step_nginx() {
  step 'Nginx 站点 + SSE 反向代理（教程 §7）'

  NGINX_CONF_PATH=$(nginx_conf_path_for_domain "$DOMAIN")

  if [ "$NO_NGINX" = 1 ]; then
    warn '已指定 --no-nginx：不动 Nginx 配置'
    info '请自己按教程 §7 建站点并加反代，location /api/ 里必须有这几行（否则 SSE 会卡）：'
    printf '%s\n' "    proxy_pass http://127.0.0.1:${PORT};"
    printf '%s\n' '    proxy_http_version 1.1; proxy_set_header Connection '"''"';'
    printf '%s\n' '    proxy_buffering off; proxy_cache off; proxy_read_timeout 3600s;'
    return 0
  fi

  if [ -z "$NGINX_CONF_DIR" ]; then
    if dry; then
      warn "本机没有 Nginx（dry-run 演示用宝塔默认路径）：${NGINX_CONF_PATH}"
    else
      die '没找到 Nginx 配置目录（/www/server/panel/vhost/nginx 或 /etc/nginx/conf.d）' \
          '先在宝塔软件商店装 Nginx（教程 §2），或加 --no-nginx 只装后端。'
    fi
  fi
  if [ -z "$NGINX_BIN" ] && ! dry; then
    die '没找到 nginx 可执行文件，无法校验/重载配置' '先在宝塔软件商店装 Nginx；或加 --no-nginx 只装后端，自己按教程 §7 配反代。'
  fi

  info "Nginx 配置文件：${NGINX_CONF_PATH}"
  mkp "$(dirname "$NGINX_CONF_PATH")"

  local had_backup=0
  if [ -f "$NGINX_CONF_PATH" ]; then
    backup_file "$NGINX_CONF_PATH" && had_backup=1
  fi

  render_nginx_conf | write_file "$NGINX_CONF_PATH" 'Nginx 站点配置（静态文件 + /api/ SSE 反代）'
  chmod_ 644 "$NGINX_CONF_PATH"

  # 校验；失败自动回滚（教程 §3 的「不改坏服务器」要求）
  if dry; then
    nginx_test
    nginx_reload
    ok 'dry-run：未真正校验/重载 Nginx'
    return 0
  fi

  if nginx_test; then
    if nginx_reload; then
      ok 'Nginx 配置校验通过并已 reload'
    else
      warn 'Nginx 配置校验通过，但 reload 失败——用 nginx -s reload 或宝塔面板手动重载一次'
    fi
  else
    local detail
    detail=$("$NGINX_BIN" -t 2>&1 | tail -n 3)
    if [ "$had_backup" = 1 ]; then
      cp -p "${NGINX_CONF_PATH}.bak.${STAMP}" "$NGINX_CONF_PATH" 2>/dev/null
      ok "已回滚到上一版配置：${NGINX_CONF_PATH}"
    else
      rmf "$NGINX_CONF_PATH"
      ok "已删除刚写入的配置（原本没有这个文件）"
    fi
    nginx_test && nginx_reload
    die 'nginx -t 校验失败，已自动回滚' "nginx -t 输出了：${detail}。多半是 Nginx 没装、配置目录不对，或站点根目录不存在：${DIR}。修好后重跑本脚本。"
  fi

  info '反向代理与 SSE 关键配置已写入：proxy_http_version 1.1 / Connection '"''"' / proxy_buffering off / proxy_cache off / proxy_read_timeout 3600s'
}

# =============================================================================
#  步骤 8：HTTPS + 自检
# =============================================================================
step_ssl_and_selftest() {
  step "HTTPS 申请 + 安装自检（教程 §8 / §9）"
  do_ssl
  do_selftest
}

do_ssl() {
  if [ "$NO_SSL" = 1 ]; then
    warn '已指定 --no-ssl：跳过 HTTPS'
    return 0
  fi
  if [ "$DOMAIN_IS_IP" = 1 ]; then
    warn "站点是 IP（${DOMAIN}），Let's Encrypt 不给 IP 签证书，跳过 HTTPS"
    return 0
  fi
  if [ "$NO_NGINX" = 1 ]; then
    warn '已指定 --no-nginx，跳过 HTTPS'
    return 0
  fi

  if ! command -v certbot >/dev/null 2>&1; then
    warn '没装 certbot，跳过自动申请（不阻断安装）'
    info '在宝塔面板里开 HTTPS（30 秒，推荐）：'
    printf '%s\n' '    网站 → 你的站点 → 设置 → SSL → Let'"'"'s Encrypt → 勾选域名 → 申请 → 打开「强制 HTTPS」'
    return 0
  fi

  local args=''
  info "用 certbot 申请证书：${DOMAIN}"
  if dry; then
    printf '  %s[dry-run]%s certbot --nginx -d %s --non-interactive --agree-tos --redirect %s\n' \
      "$C_DIM" "$C_R" "$DOMAIN" "$([ -n "$SSL_EMAIL" ] && printf -- '--email %s' "$SSL_EMAIL" || printf -- '--register-unsafely-without-email')"
    return 0
  fi
  if [ -n "$SSL_EMAIL" ]; then
    if run 'certbot 申请并开启 HTTPS' certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --email "$SSL_EMAIL"; then
      ok 'HTTPS 已开启（certbot 已自动加跳转）'
    else
      warn 'certbot 申请失败（不阻断安装）——可在宝塔面板 → 网站 → SSL 里一键申请'
    fi
  else
    if run 'certbot 申请并开启 HTTPS' certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email; then
      ok 'HTTPS 已开启（certbot 已自动加跳转）'
    else
      warn 'certbot 申请失败（不阻断安装）——也可在宝塔面板 → 网站 → SSL 里一键申请'
    fi
  fi
}

health_probe() {
  if dry; then
    printf '  %s[dry-run]%s curl -fsS --max-time 5 http://127.0.0.1:%s/api/health\n' "$C_DIM" "$C_R" "$PORT"
    HEALTH_CODE='dry'
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    HEALTH_CODE='nocurl'
    return 3
  fi
  local i=1 body=''
  while [ "$i" -le 20 ]; do
    body=$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)
    case "$body" in
      *'"db":true'*|*'"db": true'*) HEALTH_BODY="$body"; HEALTH_CODE='ok'; return 0 ;;
      *'"ok":true'*|*'"ok": true'*) HEALTH_BODY="$body"; HEALTH_CODE='nodb'; return 2 ;;
    esac
    sleep 1
    i=$((i + 1))
  done
  HEALTH_CODE='down'
  return 1
}

do_selftest() {
  health_probe
  case "$HEALTH_CODE" in
    ok)
      ok "/api/health 正常，db:true —— 后端与数据库都通了"
      dim "  ${HEALTH_BODY}"
      ;;
    dry)
      dim '  dry-run：没有真的请求健康接口（上面的命令就是正式安装时会跑的）'
      ;;
    nodb)
      warn "/api/health 能访问，但 db:false —— MySQL 没连上"
      dim "  ${HEALTH_BODY}"
      warn "排查：① 宝塔 → 软件商店 → MySQL 是否运行中；② ${DIR}/${ENV_NAME} 里 WZBP_DB_USER/PASSWORD 对不对；③ 宝塔 → 数据库 → 该用户权限是否「本地服务器」（教程 §11 Q1）"
      ;;
    down)
      warn "20 秒内 /api/health 没响应 —— Node 服务可能没起来"
      warn "排查：${SERVICE_STATUS_HINT}"
      warn "手动试跑看报错（教程 §5）：cd ${DIR} && set -a && . ./.env && set +a && ${NODE_BIN:-node} server/index.js"
      ;;
    nocurl)
      warn '服务器上没有 curl，跳过健康检查'
      ;;
  esac

  say ''
  say '============================================================'
  say "  wzbp 安装完成$([ "$DRY_RUN" = 1 ] && printf '（DRY-RUN 演练，什么都没改）')"
  say '============================================================'
  printf '%s\n' "  站点域名：   ${DOMAIN}"
  printf '%s\n' "  访问地址：   http://${DOMAIN}/$([ "$NO_SSL" = 0 ] && [ "$DOMAIN_IS_IP" = 0 ] && printf '（HTTPS 申请成功后用 https://%s/）' "$DOMAIN")"
  printf '%s\n' "  站点目录：   ${DIR}"
  printf '%s\n' "  Node 服务：  127.0.0.1:${PORT}（只监听本机，不要对公网放行 8787）"
  printf '%s\n' "  数据库：     ${DB_NAME}（用户 ${DB_USER}）"
  printf '%s\n' "  环境变量：   ${DIR}/${ENV_NAME}（chmod 600，已被 .gitignore 忽略）"
  printf '%s\n' "  安装记录：   ${DIR}/${STATE_NAME}"
  if [ "$NO_NGINX" = 0 ]; then printf '%s\n' "  Nginx 配置： ${NGINX_CONF_PATH}"; fi
  printf '%s\n' "  常驻方式：   ${ENGINE}"
  say ''
  info '下一步该干什么：'
  printf '%s\n' "    1) 浏览器打开 http://${DOMAIN}/ ，顶栏应出现「房间」入口（没有就是前端没探到 /api/health，教程 §11 Q2）"
  printf '%s\n' "    2) 打开 http://${DOMAIN}/api/health ，确认 db:true"
  printf '%s\n' "    3) 点「房间」→ 建房（赛制选随机征召，BO3）→ 复制邀请链接，另一台设备打开，点「坐下」"
  printf '%s\n' "    4) 打完一局去「战绩」里拖时间轴，能看到每一手（谁、第几手、隔了多久）"
  say ''
  info '服务状态与日志：'
  printf '%s\n' "    ${SERVICE_STATUS_HINT}"
  printf '%s\n' "    健康检查：curl http://127.0.0.1:${PORT}/api/health"
  printf '%s\n' "    数据库：  mysql -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p -e 'use ${DB_NAME}; show tables;'"
  printf '%s\n' "    备份：    mysqldump -u ${DB_USER} -p ${DB_NAME} > /www/backup/wzbp_\$(date +%F).sql"
  say ''
  info '卸载（不会删数据库）：'
  printf '%s\n' "    sudo bash install.sh --uninstall --domain ${DOMAIN}"
  if dry; then
    say ''
    warn '这是 --dry-run：以上所有操作都只打印过，系统没有任何改动。'
  fi
}

set_status_hint() {
  case "$ENGINE" in
    bt)      SERVICE_STATUS_HINT="宝塔面板 → 网站 → Node 项目 → ${SERVICE_NAME}（状态/日志/重启都在这里）；命令行：ps aux | grep server/index.js" ;;
    pm2)     SERVICE_STATUS_HINT="pm2 status / pm2 logs ${SERVICE_NAME} --lines 50 / pm2 restart ${SERVICE_NAME} / pm2 stop ${SERVICE_NAME}" ;;
    systemd) SERVICE_STATUS_HINT="systemctl status ${SERVICE_NAME} --no-pager / journalctl -u ${SERVICE_NAME} -n 50 -f / systemctl restart ${SERVICE_NAME}" ;;
    *)       SERVICE_STATUS_HINT="ps aux | grep server/index.js；ss -lntp | grep ${PORT}" ;;
  esac
}

# =============================================================================
#  卸载
# =============================================================================
step_uninstall_stop() {
  step '停止并移除常驻服务'

  local st="${DIR}/${STATE_NAME}" eng svc_state=''
  svc_state=$(state_get "$st" WZBP_STATE_SERVICE 2>/dev/null || true)
  if [ -n "$svc_state" ]; then
    ENGINE="$svc_state"
    ok "从安装记录里读到常驻方式：${ENGINE}"
  else
    choose_engine || ENGINE=''
    if [ -z "$ENGINE" ]; then
      warn '没有安装记录，只能按进程名停服务'
    else
      info "没有安装记录，按当前环境推断常驻方式：${ENGINE}"
    fi
  fi
  set_status_hint

  case "$ENGINE" in
    systemd)
      if dry; then
        printf '  %s[dry-run]%s systemctl disable --now %s; rm -f /etc/systemd/system/%s.service; systemctl daemon-reload\n' "$C_DIM" "$C_R" "$SERVICE_NAME" "$SERVICE_NAME"
      elif [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
        run "systemctl disable --now ${SERVICE_NAME}" systemctl disable --now "$SERVICE_NAME" || warn '停止 systemd 服务失败（可能本来就没在跑）'
        rmf "/etc/systemd/system/${SERVICE_NAME}.service"
        run 'systemctl daemon-reload' systemctl daemon-reload || true
      else
        warn "没找到 /etc/systemd/system/${SERVICE_NAME}.service（跳过）"
      fi
      ;;
    pm2)
      if dry; then
        printf '  %s[dry-run]%s pm2 delete %s; pm2 save\n' "$C_DIM" "$C_R" "$SERVICE_NAME"
      elif command -v pm2 >/dev/null 2>&1; then
        run "pm2 delete ${SERVICE_NAME}" pm2 delete "$SERVICE_NAME" || warn 'pm2 里没有这个进程（跳过）'
        run 'pm2 save' pm2 save || true
      else
        warn '没有 pm2（跳过）'
      fi
      rmf "${DIR}/${PM2_NAME}"
      ;;
    bt)
      if dry; then
        printf '  %s[dry-run]%s 宝塔面板 → Node 项目 → 停止并删除「%s」；pkill -f server/index.js\n' "$C_DIM" "$C_R" "$SERVICE_NAME"
      else
        run 'pkill -f server/index.js' pkill -f 'server/index.js' || warn '没有匹配的进程（跳过）'
        warn "宝塔 Node 项目记录需要你在面板里删掉：网站 → Node 项目 → ${SERVICE_NAME} → 删除"
      fi
      rmf "/www/server/nodejs/vhost/scripts/${BT_RUN_NAME}"
      ;;
    *)
      if dry; then
        printf '  %s[dry-run]%s pkill -f server/index.js\n' "$C_DIM" "$C_R"
      else
        run 'pkill -f server/index.js' pkill -f 'server/index.js' || warn '没有匹配的进程（跳过）'
      fi
      ;;
  esac
  ok '常驻服务已处理'
}

step_uninstall_nginx() {
  step '移除 Nginx 站点配置'

  local st="${DIR}/${STATE_NAME}" conf=''
  conf=$(state_get "$st" WZBP_STATE_NGINX_CONF 2>/dev/null || true)
  [ -n "$conf" ] || conf=$(nginx_conf_path_for_domain "$DOMAIN")
  NGINX_CONF_PATH="$conf"

  if [ "$NO_NGINX" = 1 ]; then
    warn '--no-nginx：不动 Nginx 配置'
    return 0
  fi

  if [ ! -f "$conf" ]; then
    warn "没找到配置文件（可能从没装过，或已删除）：${conf}"
    return 0
  fi

  backup_file "$conf"
  rmf "$conf"

  if dry; then
    nginx_test
    nginx_reload
    return 0
  fi
  if nginx_test; then
    nginx_reload && ok 'Nginx 配置已移除并 reload' || warn 'Nginx reload 失败，请手动重载一次'
  else
    # 兜底：把备份放回去，避免把服务器搞成 nginx -t 报错的状态
    cp -p "${conf}.bak.${STAMP}" "$conf" 2>/dev/null || true
    warn "删掉配置后 nginx -t 反而报错，已把备份放回：${conf}"
  fi
}

step_uninstall_notes() {
  step '剩余需要你手动处理的东西'

  say ''
  warn '数据库没有删（里面有你的房间与 BP 记录），需要自己确认后再删：'
  printf '%s\n' "    mysql -u ${DB_ROOT_USER} -p -e \"DROP DATABASE ${DB_NAME}; DROP USER '${DB_USER}'@'localhost'; DROP USER '${DB_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;\""
  say ''
  info '没有被删除的文件（确认不需要了再删）：'
  printf '%s\n' "    站点目录：${DIR}（rm -rf ${DIR}）"
  printf '%s\n' "    环境变量：${DIR}/${ENV_NAME}（含数据库密码，随目录一起删即可）"
  printf '%s\n' "    安装记录：${DIR}/${STATE_NAME}"
  printf '%s\n' "    Nginx 备份：${NGINX_CONF_PATH}.bak.*（如需恢复，改名回去再 nginx -t && nginx -s reload）"
  say ''
  if dry; then
    say '============================================================'
    say '  wzbp 卸载（DRY-RUN 演练，什么都没改）'
    say '============================================================'
  else
    say '============================================================'
    say '  wzbp 已卸载（数据库与站点文件保留）'
    say '============================================================'
  fi
}

# =============================================================================
#  主流程
# =============================================================================
main() {
  parse_args "$@"
  normalize_and_validate

  if [ "$DRY_RUN" = 1 ]; then
    STAMP='<时间戳>'
  else
    STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || printf '%s' 'bak')
  fi

  say ''
  say '============================================================'
  say "  wzbp · 王者荣耀 BP 展示台  —— 一键安装脚本 v${SCRIPT_VERSION}"
  if [ "$DRY_RUN" = 1 ]; then
    say '  模式：DRY-RUN（只打印将要做什么，绝不改动系统）'
  else
    say "  模式：正式安装（$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || printf '现在')）"
  fi
  say '============================================================'

  if [ "$UNINSTALL" = 1 ]; then
    STEP_TOTAL=4
    step_env_check_uninstall
    step_uninstall_stop
    step_uninstall_nginx
    step_uninstall_notes
    exit 0
  fi

  step_env_check
  step_prepare_dir
  step_database
  step_env_file
  step_deps
  step_service
  set_status_hint
  step_nginx
  step_ssl_and_selftest
  exit 0
}

# 卸载时的自检（不需要 Node/MySQL 就绪检查那么细）
step_env_check_uninstall() {
  step '环境自检（root）'
  detect_os
  detect_nginx
  detect_mysql
  detect_run_user
  local uid
  uid=$(id -u 2>/dev/null || printf '?')
  if [ "$uid" = '0' ]; then
    ok '以 root 运行（UID=0）'
  elif dry; then
    warn "当前不是 root（UID=${uid}）—— --dry-run 不阻断"
  else
    die "必须以 root 运行（当前 UID=${uid}）" "用 sudo：sudo bash install.sh --uninstall --domain ${DOMAIN}"
  fi
  info "将卸载：域名 ${DOMAIN}，站点目录 ${DIR}"
  confirm '确认卸载（不会删数据库）？'
}

main "$@"
