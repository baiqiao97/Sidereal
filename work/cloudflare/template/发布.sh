#!/bin/sh
# 把加密网页库发布到 Cloudflare。wrangler 会先跑 deployment-guard.cjs，校验不过就中止。
# 只上传内容有变化的文件（按哈希去重）。第一次需要先运行：npx wrangler@4.141.0 login
set -e
cd "$(dirname "$0")"
npx --yes wrangler@4.141.0 deploy
