#!/bin/bash
set -euo pipefail
cd /root/bot

echo ">>> 检查本地修改（不会自动丢弃任何代码）"
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "❌ 检测到本地修改或未跟踪文件，已停止更新以保护现有代码。"
  echo "请先检查：git status --short"
  exit 1
fi

echo ">>> 拉取最新 main"
git fetch origin main
git pull --ff-only origin main

echo ">>> 安装依赖"
npm install --omit=dev

echo ">>> 检查所有关键 JavaScript 文件"
node --check src/index.js
node --check src/cloud123.js
node --check mysql-store.js
node --check src/scanner.js

echo ">>> 检查通过，重启机器人"
pm2 restart bot || pm2 start ecosystem.config.cjs
pm2 save

echo ">>> 最近日志"
pm2 logs bot --lines 12 --nostream
