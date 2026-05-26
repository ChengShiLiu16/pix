#!/usr/bin/env bash
# pi-dev.sh - 从源码运行 pi，使用当前用户的 ~/.pi 配置
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[pi-dev] Running from source: $SCRIPT_DIR"
echo "[pi-dev] Config dir: ~/.pi (user config)"

"$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" "$@"
