#!/usr/bin/env bash
# ADBKeyBoard 一次性安装与启用脚本（用于中文/Unicode 文本输入）
# 用法：./ime-setup.sh <APK 路径> [设备序列号]
#   APK 路径也可用环境变量 ADBKEYBOARD_APK_PATH 指定
# APK 下载：https://github.com/senzhk/ADBKeyBoard/releases （GPL-2.0）

set -e

IME_ID="com.android.adbkeyboard/.AdbIME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BFF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREV_FILE="$BFF_ROOT/.ime-previous"

echo_ok()   { echo -e "  \033[32m[OK]\033[0m $1"; }
echo_warn() { echo -e "  \033[33m[!!]\033[0m $1"; }
echo_err()  { echo -e "  \033[31m[XX]\033[0m $1"; }

APK="${1:-$ADBKEYBOARD_APK_PATH}"
SERIAL="$2"
ADB=(adb)
if [ -n "$SERIAL" ]; then ADB=(adb -s "$SERIAL"); fi

if [ -z "$APK" ]; then
    echo_err "未指定 APK 路径。"
    echo "用法：$0 <APK 路径> [设备序列号]"
    echo "或：export ADBKEYBOARD_APK_PATH=/path/to/keyboardservice-debug.apk"
    echo "下载：https://github.com/senzhk/ADBKeyBoard/releases"
    exit 1
fi

if [ ! -f "$APK" ]; then
    echo_err "APK 文件不存在：$APK"
    exit 1
fi

CURRENT="$("${ADB[@]}" shell settings get secure default_input_method | tr -d '\r\n')"
echo_ok "当前输入法：${CURRENT:-（未能读取）}"

# 已是 ADBKeyBoard 时不覆盖记录，否则还原目标会变成自己
if [ "$CURRENT" = "$IME_ID" ]; then
    echo_warn "ADBKeyBoard 已是当前输入法，保留原有 .ime-previous"
else
    echo "$CURRENT" > "$PREV_FILE"
    echo_ok "原输入法已记录到 .ime-previous"
fi

"${ADB[@]}" install -r "$APK"
echo_ok "APK 已安装"

# 安装后输入法可能需短暂时间才出现在系统列表
if ! "${ADB[@]}" shell ime enable "$IME_ID"; then
    echo_warn "enable 失败，等待 1 秒后重试"
    sleep 1
    "${ADB[@]}" shell ime enable "$IME_ID"
fi
echo_ok "输入法已启用"

"${ADB[@]}" shell ime set "$IME_ID"
echo_ok "已切换为 ADBKeyBoard，现在可以输入中文"
echo ""
echo "还原原输入法：pnpm --filter flutter-dev-bff ime:restore"
