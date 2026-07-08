# Aurafile — Docker 镜像（飞牛 NAS / fnOS fpk 友好）
FROM node:18-alpine

ENV NODE_ENV=production

# 构建依赖 + 离线媒体工具（sharp 自带 libvips；ffmpeg 抽帧；p7zip 解 7z；exiftool 备用）
RUN apk add --no-cache \
      python3 make g++ \
      ffmpeg \
      vips \
      p7zip \
      perl-image-exiftool \
      tini \
      su-exec

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
# node:18-alpine 已内置非 root 用户 node(uid 1000/gid 1000)，直接复用，避免自建用户 gid 冲突（F-14）
# COPY 之后再 chown，确保 /app 下所有文件（含 node_modules、源码）归 node 所有，运行时可读写
RUN chown -R node:node /app \
 && chmod +x /app/entrypoint.sh

RUN mkdir -p /data /config/aurafile
EXPOSE 8011

ENV AURAFILE_ROOT=/data \
    AURAFILE_DATA=/config/aurafile \
    PORT=8011

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8011/api/health || exit 1
