#!/usr/bin/env bash
# build.sh —— 一键重建 embedded-mcp-toolkit 项目介绍 PPT（Linux/macOS 版，与 build.ps1 等价）
# 用法：bash build.sh   或   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

TARGET="embedded-mcp-toolkit-项目介绍.pptx"
TMP_NEW=".tmp/out_new.pptx"
TMP_FIX=".tmp/out_fixed.pptx"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
err() { echo -e "${RED}[X] $*${NC}" >&2; exit 1; }
step() { echo -e "${CYAN}$*${NC}"; }

# ---- 0. 依赖检查 ----
command -v node >/dev/null 2>&1 || err "未找到 node，请先安装 Node.js"
PYTHON=""
for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then PYTHON="$c"; break; fi
done
[ -n "$PYTHON" ] || err "未找到 python3/python，请先安装 Python"
[ -d "../node_modules/pptxgenjs" ] || err "缺少 pptxgenjs：在仓库根目录执行  npm i -D pptxgenjs"
mkdir -p .tmp

# ---- 1. 占用预检（Linux 下无 PowerPoint 锁，仅做写测试提示）----
for f in "$TMP_NEW" "$TMP_FIX" "$TARGET"; do
    if [ -e "$f" ] && [ ! -w "$f" ]; then
        err "文件不可写，请检查权限或关闭占用程序：$f"
    fi
done

# ---- 2. 生成 ----
step "[2/4] node build_ppt.mjs"
node build_ppt.mjs || err "生成失败"

# ---- 3. 后处理（修复 pptxgenjs 的 <a:pPr> 重复，否则 PowerPoint 打不开）----
step "[3/4] $PYTHON post_fix.py"
"$PYTHON" post_fix.py "$TMP_NEW" "$TMP_FIX" || err "后处理失败"

# ---- 4. 覆盖成品 ----
cp -f "$TMP_FIX" "$TARGET"
echo -e "${GREEN}[OK] 已生成 $(pwd)/$TARGET${NC}"
