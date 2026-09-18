#!/usr/bin/env bash
# =====================================================
# MCP Server 进程清理脚本（embedded-mcp-toolkit，Linux 版）
#
#   与 scripts/win-stop-mcp.ps1 对偶：扫描本机所有 MCP 进程并列出，由用户确认后
#   整树结束，覆盖 Linux 上的三种启动形态：
#     - node 本地 ： node -> bin/embedded-mcp-toolkit-cli.js
#     - node 远程 ： sshd -> bash -c ... -> node（中间那层 shell 作为进程树根一并清理）
#     - exe 形态  ： ./embedded-mcp-toolkit(.exe)（Bun 单文件可执行，Linux 目标产物）
#
#   匹配规则（任一命中即算目标）：
#     1. 进程名（/proc/<pid>/exe 符号链接的 basename）自带工具名 —— exe 形态就是
#        这种：进程名叫 embedded-mcp-toolkit / embedded-mcp-toolkit.exe，无论它放
#        在哪、由谁拉起（脚本 / .mcp.json / 手工执行）都能认出来，不依赖命令行；
#     2. 进程名是 node / nodejs / bun 或 bash / sh / dash / zsh，且命令行命中关键字
#        —— node 形态靠脚本路径（bin/embedded-mcp-toolkit-cli.js）认，中间那层
#        shell 靠 remote-start-mcp 认，不论它是本地起还是远程 ssh 起，它都会作为
#        进程树的根被包含进来。
#   其余进程一律不看：命令行里带项目路径的无关进程（编辑器 argv 里带路径等）不能
#   因此被误杀。
#
#   结束方式：Windows 用 taskkill /T /F 整树递归，Linux 没有等价命令，本脚本自己
#   按 /proc 的父子关系递归收集后代，再「子先父后」发 SIGTERM，稍候对残余补
#   SIGKILL（与 taskkill /T 的行为一致）。Node 的 proc.kill() 只杀本体，命令里起的
#   子进程会变成孤儿（同 src/sdk/tools/win/powershell.ts、cloudflared 停止逻辑的
#   结论），所以必须整树清理。
#
#   输出只报进程名（img）与命令行，不区分本地/远程：本地同样可能用脚本起，区分
#   意义不大，看命令行即可辨明来源。
#
#   用法：
#     bash scripts/linux-stop-mcp.sh
#     bash scripts/linux-stop-mcp.sh -f | --force     跳过交互确认（非交互场景）
#     bash scripts/linux-stop-mcp.sh -k <关键字>      追加关键字（可重复；默认关键字仍生效）
#     bash scripts/linux-stop-mcp.sh -h | --help      查看帮助
#
#   退出码：0 = 已清理干净 或 用户主动取消；1 = 仍有残留、非交互下未加 -f、前置检查失败
#
#   兼容性 / 依赖：
#     - 纯 bash + /proc，不依赖 ps / pgrep / killall / pkill（精简容器里常缺）；
#     - 需要 bash 4+（关联数组）；
#     - /proc/<pid>/cmdline 只有属主与 root 读得到：他人 / root 进程读不到命令行时，
#       exe 形态仍能靠进程名命中，node 形态会漏扫，需 sudo 运行本脚本；
#     - 内核把 /proc/<pid>/comm 截到 15 字符，故进程名取 exe 符号链接 basename，
#       读不到（他人进程）才退回 comm；
#     - 僵尸进程（state=Z）不参与匹配与复查，避免把「已退出但父进程未回收」误报成存活。
#
#   漏扫排查：如 MCP 换过启动方式（命令行里既没有 embedded-mcp-toolkit 也没有
#   remote-start-mcp），或 exe 被改过名（进程名不再带工具名），用 -k 追加关键字。
# =====================================================
set -uo pipefail

if ((BASH_VERSINFO[0] < 4)); then
    echo "本脚本需要 bash 4+（使用了关联数组），当前版本：$BASH_VERSION" >&2
    exit 1
fi

# 默认关键字（-k 是在此基础上追加，不是替换）
KEYWORDS=(
    "embedded-mcp-toolkit" # bin/embedded-mcp-toolkit-cli.js、Linux exe 产物、项目路径
    "remote-start-mcp"     # 远程 ssh 会话里拉起 MCP 的那个 shell（.sh / .bat 通用）
    "out/cli/index.js"     # npm start / 直接跑编译产物（相对路径不带项目名）
)
EXTRA_KEYWORDS=()
FORCE=0

usage() {
    cat <<'EOF'
MCP Server 进程清理脚本（embedded-mcp-toolkit，Linux 版）

用法：
  bash scripts/linux-stop-mcp.sh [选项]

选项：
  -f, --force            跳过交互确认，直接结束全部命中的进程树（非交互场景）
  -k, --keyword <文本>   追加匹配关键字，可重复；默认关键字仍然生效
  -h, --help             显示本帮助

示例：
  bash scripts/linux-stop-mcp.sh
  bash scripts/linux-stop-mcp.sh --force
  bash scripts/linux-stop-mcp.sh -k /opt/mcp/bin/ -k mcp-gateway
EOF
}

# -----------------------------------------------------
# 参数解析
# -----------------------------------------------------
while (($# > 0)); do
    case "$1" in
        -f | --force)
            FORCE=1
            shift
            ;;
        -k | --keyword)
            if (($# < 2)); then
                echo "-k/--keyword 缺少参数" >&2
                exit 1
            fi
            EXTRA_KEYWORDS+=("$2")
            shift 2
            ;;
        --keyword=*)
            EXTRA_KEYWORDS+=("${1#*=}")
            shift
            ;;
        -k?*)
            EXTRA_KEYWORDS+=("${1#-k}")
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "未知参数：$1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if ((${#EXTRA_KEYWORDS[@]} > 0)); then
    KEYWORDS+=("${EXTRA_KEYWORDS[@]}")
fi

# node / shell 形态需要靠命令行认的镜像名（exe 形态不在这里，它靠进程名自带工具名
# 直接命中，见 match_keyword 调用处）；用大小写不敏感比较，故统一转小写。
SHELL_IMAGE_NAMES=" node nodejs bun bash sh dash zsh "

# -----------------------------------------------------
# 工具函数
# -----------------------------------------------------

# 文本是否命中任一关键字（不区分大小写，避免路径大小写差异漏扫）
match_keyword() {
    local text="${1,,}" k
    for k in "${KEYWORDS[@]}"; do
        [[ -n $k && $text == *"${k,,}"* ]] && return 0
    done
    return 1
}

# 关键字列表拼成一行（仅用于提示信息，避免 "${arr[*]}" 只认 IFS 首字符）
join_keywords() {
    local out="" k
    for k in "${KEYWORDS[@]}"; do
        out+="${out:+ / }$k"
    done
    printf '%s' "$out"
}

# 进程是否存活（不存在或已是僵尸都算不存活）
pid_alive() {
    local pid=$1 stat rest state
    [[ -d "/proc/$pid" ]] || return 1
    stat="$(<"/proc/$pid/stat")" 2>/dev/null || return 1
    rest="${stat##*)}" # 去掉 "pid (comm)" 前缀：comm 里可能带空格（甚至括号）
    # shellcheck disable=SC2086
    set -- $rest
    state="${1:-}"
    [[ $state == "Z" ]] && return 1
    return 0
}

# 进程列表（每次采集都整体重建，避免用到过期快照）
declare -A PPID_OF=() NAME_OF=() CMD_OF=()
ALL_PIDS=()
collect_processes() {
    PPID_OF=()
    NAME_OF=()
    CMD_OF=()
    ALL_PIDS=()
    local d pid stat rest state ppid comm exe raw
    for d in /proc/[0-9]*; do
        pid="${d#/proc/}"
        [[ -r "$d/stat" ]] || continue
        stat="$(<"$d/stat")" 2>/dev/null || continue
        rest="${stat##*)}" # 去掉 "pid (comm)" 前缀
        # shellcheck disable=SC2086
        set -- $rest
        state="${1:-}"
        ppid="${2:-0}"
        [[ $state == "Z" ]] && continue # 僵尸进程不参与匹配（见文件头说明）
        comm="${stat#*(}"
        comm="${comm%%)*}"
        # 镜像名优先取 exe 符号链接的 basename：comm 被内核截到 15 字符，
        # embedded-mcp-toolkit 会被截成 embedded-mcp-tool，靠 comm 认不出来。
        exe=""
        raw="$(readlink "$d/exe" 2>/dev/null)"
        [[ -n $raw ]] && exe="${raw##*/}"
        [[ -n $exe ]] || exe="$comm"
        raw="$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null)"
        ALL_PIDS+=("$pid")
        PPID_OF["$pid"]="$ppid"
        NAME_OF["$pid"]="$exe"
        CMD_OF["$pid"]="${raw% }"
    done
}

# 从进程列表里筛出 MCP 进程（排除自身及祖先）
TARGETS=()
get_targets() {
    TARGETS=()
    local pid name cmd
    for pid in "${ALL_PIDS[@]}"; do
        [[ -n ${PROTECTED[$pid]:-} ]] && continue
        name="${NAME_OF[$pid]}"
        # exe 形态：进程名自带工具名，放哪都能认，不看命令行
        if match_keyword "$name"; then
            TARGETS+=("$pid")
            continue
        fi
        # node / shell 形态：只认固定的几个镜像名，且命令行要命中关键字，避免误杀
        [[ $SHELL_IMAGE_NAMES == *" ${name,,} "* ]] || continue
        cmd="${CMD_OF[$pid]:-}"
        [[ -n $cmd ]] || continue # 读不到命令行（他人/提权进程）就跳过
        match_keyword "$cmd" && TARGETS+=("$pid")
    done
}

# -----------------------------------------------------
# 1. 采集进程 + 自身祖先链（防自杀）
# -----------------------------------------------------
collect_processes

# 本脚本自身及其所有祖先一律排除：脚本本体、拉起它的 shell / npm / node / 终端都
# 可能命中关键字（尤其是本仓库路径就叫 embedded-mcp-toolkit），杀了会中断自己。
declare -A PROTECTED=()
PROTECTED[$$]=1
cursor=$$
for ((i = 0; i < 16; i++)); do
    parent="${PPID_OF[$cursor]:-}"
    [[ -z $parent || $parent -le 0 ]] && break
    [[ -n ${PROTECTED[$parent]:-} ]] && break
    PROTECTED[$parent]=1
    cursor=$parent
done

# -----------------------------------------------------
# 2. 扫描 + 展示
# -----------------------------------------------------
get_targets  # 先按 PROTECTED 过滤掉自身与祖先，再匹配
if ((${#TARGETS[@]} == 0)); then
    echo "未发现运行中的 MCP 进程（关键字：$(join_keywords)）。"
    exit 0
fi

declare -A TARGET_SET=()
for pid in "${TARGETS[@]}"; do
    TARGET_SET["$pid"]=1
done

# 只保留「根」进程：父进程也命中的（链路里的 node / shell）交给父进程的整树清理
# 一起收，避免重复结束、以及父进程后退出时的二次报错。
ROOTS=()
for pid in "${TARGETS[@]}"; do
    [[ -n ${TARGET_SET[${PPID_OF[$pid]}]:-} ]] || ROOTS+=("$pid")
done

# 逐个分行打印，不用对齐表格：中文字符在终端是双宽字符，按字符数对齐的列在中文
# 内容下会参差不齐；分行还能把完整命令行打全，便于辨认来源。
echo "发现 ${#TARGETS[@]} 个 MCP 进程（共 ${#ROOTS[@]} 棵进程树）："
index=0
for pid in "${TARGETS[@]}"; do
    index=$((index + 1))
    if [[ -n ${TARGET_SET[${PPID_OF[$pid]}]:-} ]]; then
        note="子进程，随父进程树一起结束"
    else
        note="根进程"
    fi
    echo "  [$index] PID=$pid PPID=${PPID_OF[$pid]} img=${NAME_OF[$pid]} （$note）"
    echo "      cmd: ${CMD_OF[$pid]}"
done

# -----------------------------------------------------
# 3. 交互确认
# -----------------------------------------------------
if ((FORCE == 0)); then
    if [[ ! -t 0 ]]; then
        echo "当前会话无法交互输入，请改用 -f/--force 显式确认。" >&2
        exit 1
    fi
    read -r -p "确认结束以上全部进程树？[y/N] " answer || answer=""
    case "$answer" in
        y | Y | yes | YES | Yes) ;;
        *)
            echo "已取消，未结束任何进程。"
            exit 0
            ;;
    esac
fi

# -----------------------------------------------------
# 4. 整树结束
# -----------------------------------------------------

# 按 /proc 快照的父子关系递归收集后代，再「子先父后」结束：父进程先死会让子进程
# 被 init 收养，之后就很难从进程树找到它们了（对应 taskkill /T 的递归顺序）。
kill_tree() {
    local root=$1
    local -a order=() queue=("$root")
    local cur pid i
    while ((${#queue[@]} > 0)); do
        cur="${queue[0]}"
        queue=("${queue[@]:1}")
        order+=("$cur")
        for pid in "${ALL_PIDS[@]}"; do
            [[ ${PPID_OF[$pid]:-} == "$cur" ]] && queue+=("$pid")
        done
    done

    # 先 SIGTERM：给 MCP Server 自己收尾的机会（关串口、断 ssh、清临时文件）
    for ((i = ${#order[@]} - 1; i >= 0; i--)); do
        kill -TERM "${order[$i]}" 2>/dev/null || true
    done
    sleep 0.3
    # 再对残余 SIGKILL：MCP 里可能有阻塞在 IO 上的子进程（串口 / ssh 转发）
    for ((i = ${#order[@]} - 1; i >= 0; i--)); do
        pid="${order[$i]}"
        if pid_alive "$pid"; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    return 0
}

killed=0
for pid in "${ROOTS[@]}"; do
    name="${NAME_OF[$pid]}"
    if ! pid_alive "$pid"; then
        echo "PID $pid 已自行退出，跳过"
        continue
    fi
    kill_tree "$pid"
    if pid_alive "$pid"; then
        echo "结束 PID $pid ($name) 失败，可能无权限（试试 sudo 运行）。" >&2
    else
        killed=$((killed + 1))
        echo "已结束进程树 PID $pid ($name)"
    fi
done

# -----------------------------------------------------
# 5. 复查
# -----------------------------------------------------
sleep 0.3
collect_processes
get_targets
if ((${#TARGETS[@]} == 0)); then
    echo "已结束 $killed 棵进程树，MCP 进程已全部清理。"
else
    echo "仍有 ${#TARGETS[@]} 个进程存活（权限不足或正处于启动竞态）：" >&2
    for pid in "${TARGETS[@]}"; do
        echo "  PID $pid img=${NAME_OF[$pid]} cmd=${CMD_OF[$pid]}" >&2
    done
    exit 1
fi
