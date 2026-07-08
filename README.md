# Aurafile（光匣）

> 梦幻柔和的离线 NAS 文件管理器 · 为飞牛 NAS（fnOS）fpk 窗口打造

## 项目简介

Aurafile（光匣）是一款为飞牛 NAS（fnOS）打造的**完全离线**文件管理器。它将 Web 应用打包为 fpk 窗口，由 fnOS 以本地窗口（webview）形式打开，专注于单机 / 内网 NAS 场景。一切运行在本地 Docker 容器之内——没有任何联网请求、遥测或广告，你的文件只属于你。

## ✨ 主要功能特性

- 🗂️ **完整文件操作**：重命名、删除至回收站、彻底删除、复制 / 粘贴 / 剪切、撤销 / 重做
- 🔎 **搜索与筛选**：按文件名、类型、大小、时间筛选，并支持**文件内部文本全文检索**
- 🖼️ **缩略图与 EXIF**：图片（sharp）、视频抽帧（ffmpeg）生成缩略图，可查看文档与照片 EXIF 元信息
- 📐 **详情面板**：大小、路径、创建 / 修改时间、权限一目了然
- 🗜️ **压缩 / 解压**：支持 zip、tar.gz、7z，内置 Zip-Slip 与解压炸弹防护
- ⚡ **增量索引**：基于 chokidar 的实时监控，搜索秒级响应
- 🕒 **时间轴视图**：按今天 / 昨天 / 本周 / 本月 / 年月 自动分组浏览
- 💝 **关于页**：作者 GitHub 与捐赠渠道，全程**无任何广告**

## 🖥️ 支持的架构

- **当前支持 X86 / amd64**：CI 在 GitHub `ubuntu-latest`（amd64）runner 上构建，发布的 fpk 镜像为 amd64。
- **arm64（aarch64）**：暂未提供 —— 当前仅构建并支持 X86 / amd64 镜像；如需要 arm64 请关注后续版本。

## 🔒 完全离线声明

Aurafile 不发出任何出站网络请求：**无 CDN、无遥测、无后台上报、无内置广告**。所有索引、检索与预览均在本地完成，文件与元数据不会离开你的 NAS。（自动更新是 fnOS 从 GitHub Release 拉取安装包，属于发行机制，运行时本身仍完全离线。）

## 📦 安装方式

### (a) Docker 手动运行

```bash
docker build -t aurafile .
docker run -p 8018:8018 \
  -e AURAFILE_ROOT=/data -e AURAFILE_UID=$(id -u) -e AURAFILE_GID=$(id -g) \
  -v /your/nas/share:/data \
  -v aurafile-config:/config/aurafile \
  aurafile
# 打开 http://127.0.0.1:8018
```

### (b) fnOS 手动导入 fpk

从本仓库的 GitHub Release 下载 `aurafile-<版本号>.fpk`，在 fnOS 应用中心选择「手动安装 / 导入本地应用」，选中该文件即可完成安装。

### (c) fnOS 自动更新

仓库打 `vX.Y.Z` 标签 → CI 自动构建并发布 Release 与 `latest.json`，fnOS 据此自动拉取并安装新版本。

## 🛡️ 安全模型

- **完全离线**：运行时无任何出站网络请求、无 CDN、无遥测。
- 所有用户路径均经 `resolveSafe` / `resolveWithin` 约束在管理根目录（ROOT）内，防路径穿越。
- 默认监听 `0.0.0.0`（容器内），对外通过 fnOS 窗口 / 端口映射访问；如需仅本机可设 `AURAFILE_HOST=127.0.0.1`。
- 容器默认以非 root 用户 **`node`（uid 1000）** 运行（复用 `node:18-alpine` 内置用户），可用 `AURAFILE_UID` / `AURAFILE_GID` 映射 NAS 共享属主。

## 🔧 开发 / 快速运行

```bash
npm install
AURAFILE_ROOT=/path/to/your/files npm start
# 打开 http://127.0.0.1:8018
```

冒烟测试：

```bash
node scripts/smoke.js
```

## 📌 版本与自动更新

每次在仓库打 `vX.Y.Z` 标签，GitHub Actions 会自动：

1. 构建 Docker 镜像
2. 打包标准 fnOS fpk 脚手架（INI manifest + app/docker/docker-compose.yaml；镜像不内嵌，运行时由 compose 从 ghcr.io/planover/aurafile:latest 拉取）
3. 生成 `latest.json`
4. 发布 GitHub Release

版本号随 tag 自动同步，由 CI 写入 fpk 的 INI manifest 与 latest.json（不再使用旧的 JSON fpk.json）。

## 📄 许可证

MIT
