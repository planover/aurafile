# Aurafile（光匣）

> 梦幻柔和的离线 NAS 文件管理器 · 为飞牛 NAS（fnOS）fpk 窗口打造

Aurafile 是一款**完全离线、无任何外部网络请求**的 NAS 文件管理 Web 应用。
它运行在 Docker 容器中，由 fnOS 以本地窗口（webview）形式打开，适合单机 / 内网 NAS 场景。

## 特性

- 🗂️ 完整文件操作：重命名、删除至回收站、彻底删除、复制 / 粘贴 / 剪切、撤销 / 重做
- 🔎 搜索与筛选：按文件名、类型、大小、时间，以及**文件内部文本全文检索**
- 🖼️ 缩略图预览：图片（sharp）、视频抽帧（ffmpeg）；文档 / EXIF 元信息查看
- 📐 详情面板：大小、路径、创建 / 修改时间、权限
- 🗜️ 压缩 / 解压：zip、tar.gz、7z（带防 Zip-Slip 与解压炸弹防护）
- ⚡ 增量索引：基于 chokidar 的实时监控，搜索秒开
- 🕒 时间轴视图：按今天 / 昨天 / 本周 / 本月 / 年月 自动分组
- 💝 关于页：作者 GitHub 与捐赠二维码，**无任何广告**

## 安全模型

- **完全离线**：运行时无任何出站网络请求、无 CDN、无遥测。
- 所有用户路径均经 `resolveSafe` / `resolveWithin` 约束在管理根目录（ROOT）内，防路径穿越。
- 默认仅监听 `127.0.0.1`；如需跨设备访问请通过反向代理并自行加鉴权。
- 容器默认以非 root 用户 `aura`（uid 1000）运行（可用 `AURAFILE_UID` / `AURAFILE_GID` 映射 NAS 共享属主）。

## 快速运行（开发）

```bash
npm install
AURAFILE_ROOT=/path/to/your/files npm start
# 打开 http://127.0.0.1:8080
```

冒烟测试：

```bash
node scripts/smoke.js
```

## Docker / fpk 部署

```bash
docker build -t aurafile .
docker run -p 8080:8080 \
  -e AURAFILE_ROOT=/data -e AURAFILE_UID=$(id -u) -e AURAFILE_GID=$(id -g) \
  -v /your/nas/share:/data \
  -v aurafile-config:/config/aurafile \
  aurafile
```

在 fnOS 中：导入本仓库发布的 `aurafile.fpk` 即可。更新由 CI 自动构建并发布 Release，
fnOS 依据 `latest.json` 拉取新版本。

## 版本与自动更新

每次在仓库打 `vX.Y.Z` 标签，GitHub Actions 会自动：

1. 构建 Docker 镜像
2. 打包 `aurafile.fpk`（含镜像与 manifest）
3. 生成 `latest.json`
4. 发布 GitHub Release

## 许可证

MIT
