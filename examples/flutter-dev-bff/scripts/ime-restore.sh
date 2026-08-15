#!/usr/bin/env bash
# 还原 ime-setup.sh 切换前的输入法
# 用法：./ime-restore.sh [设备序列号]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BFF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREV_FILE="$BFF_ROOT/.ime-previous"

echo_ok()  { echo -e "  \033[32m[OK]\033[0m $1"; }
echo_err() { echo -e "  \033[31m[XX]\033[0m $1"; }

SERIAL="$1"
ADB=(adb)
if [ -n "$SERIAL" ]; then ADB=(adb -s "$SERIAL"); fi

if [ ! -f "$PREV_FILE" ]; then
    echo_err "未找到 $PREV_FILE，无法确定还原目标。"
    echo "请在设备的「设置 → 语言与输入法」中手动切换。"
    exit 1
fi

PREV="$(tr -d '\r\n' < "$PREV_FILE")"
if [ -z "$PREV" ]; then
    echo_err ".ime-previous 内容为空，无法确定还原目标。"
    echo "请在设备的「设置 → 语言与输入法」中手动切换。"
    exit 1
fi

"${ADB[@]}" shell ime set "$PREV"
echo_ok "已还原为：$PREV"
