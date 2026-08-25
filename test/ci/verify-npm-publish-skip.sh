#!/usr/bin/env bash
# 验证 .cnb/workflows/npm-publish.yml 中「版本已存在则跳过发布」逻辑
#
# 用法:
#   bash test/ci/verify-npm-publish-skip.sh            # 沙箱模拟(无网络、不真正发布)
#   bash test/ci/verify-npm-publish-skip.sh --network  # 追加真实 npm registry 连通性检查
#
# 原理:
#   1. 从 yml 中提取「发布到 npm」阶段的 script 块(测试真实内容而非副本)
#   2. 在临时沙箱中放置 stub package.json 与假 npm 命令:
#      - npm view <name>@<ver> version  → 查 fixture 文件, 命中输出版本退出 0, 未命中模拟 E404 退出 1
#      - npm publish                    → 仅记录调用, 不真正发布
#   3. 断言两种场景: 版本已存在 → 跳过且不调用 publish; 版本不存在 → 调用 publish

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
YML="$ROOT/.cnb/workflows/npm-publish.yml"
PASS=0; FAIL=0

note() { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

[ -f "$YML" ] || { note "❌ 找不到 $YML"; exit 1; }

# ---------- 1. 从 yml 提取「发布到 npm」阶段的 script 块(12 空格缩进) ----------
SCRIPT="$(awk '/- name: 发布到 npm/{g=1} g && /script: \|/{s=1; next} s' "$YML" | sed -E 's/^ {12}//')"
if [ -z "$SCRIPT" ] || ! grep -q 'npm view' <<<"$SCRIPT"; then
  note "❌ 未能从 yml 提取到发布脚本(缺少 npm view 检查?)"
  exit 1
fi
ok "已从 yml 提取发布脚本 ($(wc -l <<<"$SCRIPT" | tr -d ' ') 行)"

# ---------- 2. 搭建沙箱 ----------
SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
BIN="$SB/bin"; HOME_S="$SB/home"
mkdir -p "$BIN" "$HOME_S"

# stub package.json: 固定 name/version, 与真实项目一致
cat > "$SB/package.json" <<'EOF'
{ "name": "@smai-kit/embedded-mcp-toolkit", "version": "1.4.0" }
EOF

# 假 npm: view 查 fixture, publish 仅记录调用
cat > "$BIN/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_NPM_CALLS"
case "$1" in
  view)
    if [ -f "$FAKE_NPM_REGISTRY" ] && grep -Fxq "$2" "$FAKE_NPM_REGISTRY"; then
      echo "${2##*@}"; exit 0
    fi
    echo "npm error code E404" >&2
    echo "npm error 404 Not Found - GET $2" >&2
    exit 1
    ;;
  publish) exit 0 ;;
  *)       exit 0 ;;
esac
EOF
chmod +x "$BIN/npm"

NODE_BIN_DIR="$(dirname "$(command -v node)")"

run_case() { # $1=是否写入 registry fixture 的版本行(空=不存在)
  : > "$SB/calls"; : > "$SB/registry"
  [ -n "${1:-}" ] && printf '%s\n' "$1" > "$SB/registry"
  rm -f "$HOME_S/.npmrc"
  (
    cd "$SB" && env -i \
      PATH="$BIN:$NODE_BIN_DIR:/usr/bin:/bin" \
      HOME="$HOME_S" \
      FAKE_NPM_CALLS="$SB/calls" \
      FAKE_NPM_REGISTRY="$SB/registry" \
      NPM_ACCESS_TOKENS="fake-token" \
      bash -c "$SCRIPT"
  ) > "$SB/out" 2>&1
}

# ---------- 场景 A: 版本已存在 → 跳过发布 ----------
note ""
note "[A] 版本已存在于 npm registry:"
run_case "@smai-kit/embedded-mcp-toolkit@1.4.0"
if grep -q "npm view" "$SB/calls" && grep -q "跳过发布" "$SB/out" && ! grep -q "npm publish" "$SB/calls"; then
  ok "输出跳过提示, 且未调用 npm publish"
else
  bad "版本已存在时应跳过发布"; sed 's/^/    | /' "$SB/out" "$SB/calls"
fi
if [ -f "$HOME_S/.npmrc" ]; then
  bad "跳过时不应写入 .npmrc"
else
  ok "跳过时未写入 .npmrc(未暴露 token)"
fi

# ---------- 场景 B: 版本不存在 → 执行发布 ----------
note ""
note "[B] 版本不存在于 npm registry:"
run_case ""
if grep -q "发布成功" "$SB/out" && grep -q "npm publish --access public" "$SB/calls"; then
  ok "调用 npm publish 并输出成功提示"
else
  bad "版本不存在时应执行发布"; sed 's/^/    | /' "$SB/out" "$SB/calls"
fi
if grep -q "fake-token" "$HOME_S/.npmrc" 2>/dev/null; then
  ok "发布前已写入 .npmrc(注入 token)"
else
  bad "发布前未写入 .npmrc"
fi

# ---------- 场景 C(可选): 真实 registry 连通性 ----------
if [ "${1:-}" = "--network" ]; then
  note ""
  note "[C] 真实 registry 检查:"
  if npm view "@smai-kit/embedded-mcp-toolkit@1.4.0" version >/dev/null 2>&1; then
    ok "1.4.0 已存在(npm view 退出码 0 → 会走跳过分支)"
  else
    bad "查询 1.4.0 失败(网络不可用?)"
  fi
  if npm view "@smai-kit/embedded-mcp-toolkit@0.0.0-no-such-version" version >/dev/null 2>&1; then
    bad "不存在的版本不应查询成功(会误判为已存在)"
  else
    ok "不存在版本退出码非 0(符合 if 判断, 会走发布分支)"
  fi
fi

note ""
note "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
