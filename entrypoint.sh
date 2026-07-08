#!/bin/sh
# Aurafile 容器入口：处理运行身份映射，降低权限后启动服务（F-14）
set -e

if [ -n "$AURAFILE_UID" ] && [ -n "$AURAFILE_GID" ]; then
  chown -R "$AURAFILE_UID:$AURAFILE_GID" /config/aurafile 2>/dev/null || true
  exec su-exec "$AURAFILE_UID:$AURAFILE_GID" node server.js
else
  # 默认以非 root 用户 node(1000) 运行，降低容器权限
  chown -R 1000:1000 /config/aurafile 2>/dev/null || true
  exec su-exec 1000:1000 node server.js
fi
