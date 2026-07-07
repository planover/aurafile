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
# 创建非 root 运行用户，降低权限（F-14）
RUN addgroup -g 1000 aura \
 && adduser -D -u 1000 -G aura aura \
 && chown -R aura:aura /app

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /data /config/aurafile
EXPOSE 8080

ENV AURAFILE_ROOT=/data \
    AURAFILE_DATA=/config/aurafile \
    PORT=8080

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1
