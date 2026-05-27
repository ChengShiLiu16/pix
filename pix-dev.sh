#!/usr/bin/env bash
# pix-dev.sh - 从源码运行 pix，使用当前用户的 ~/.pix 配置
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[pix-dev] Running from source: $SCRIPT_DIR"
echo "[pix-dev] Config dir: ~/.pix (user config)"

"$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" "$@"
