# Changelog

All notable changes to Aurafile (光匣) will be documented in this file.

## [0.1.5] - 2026-07-08

### Fixed
- **修复容器启动失败 `[FATAL tini] exec /app/entrypoint.sh failed: Permission denied`**：Dockerfile 在 `COPY . .` 后未给 `entrypoint.sh` 添加执行权限。新增 `RUN chmod +x /app/entrypoint.sh`。
- **修复桌面图标/窗口不显示**：根因为容器因权限问题崩溃 → `service_port` 从未监听 → fnOS `checkport=true` 检查失败 → 不注册桌面入口。修复权限后容器正常启动，桌面图标将自动出现。

### Changed
- **默认端口从 8080 改为 8011**（用户要求，8080 在 fnOS 上被占用）：
  - `Dockerfile`：`EXPOSE 8011`、`PORT=8011`、healthcheck URL
  - `fpk/manifest`：`service_port = 8011`
  - `fpk/app/docker/docker-compose.yaml`：端口映射 `8011:8011`、`PORT=8011`
  - `fpk/ui/config`：`port: "8011"`
  - `src/config.js`：默认 PORT 回退值 `8011`
  - `server.js` 注释、`README.md` 示例命令同步更新
- **容器网络改为默认 bridge**：`docker-compose.yaml` 新增 `network_mode: bridge`，不再由 compose 新建自定义网络。

## [0.1.4] - 2026-07-08

### Fixed
- **修复「解压 app.tgz 失败」**（#1 安装阻塞）：fpk 根目录缺少 `app.tgz` 文件。fnOS 安装 Docker 应用时会从 fpk 内提取 `app.tgz` 获取应用运行时文件（含 docker-compose.yaml），缺失则安装中断并报错。
- CI 打包流程新增自动生成 `app.tgz` 步骤：在 tar.gz 打包前先从 `fpk/app/` 目录生成 `app.tgz`。

## [0.1.3] - 2026-07-08

### Fixed
- **修复「不是有效的 fpk 文件」**（核心格式重做）：
  - fpk 打包格式从 `zip` 改为 `tar.gz`（fnOS .fpk 本质是 gzip 压缩的 tar 包）
  - manifest 字段修正：`description` → `desc`（必填字段名）、添加 `maintainer`
  - `config/privilege` 改为官方格式：`{"defaults":{"run-as":"package"},"username":"aurafile","groupname":"aurafile"}`
  - `config/resource` 添加 `docker-project` 声明（Docker 应用必填）
  - `ui/config` 改为标准 `.url` 入口 JSON 格式
  - `cmd/main` 重写为 Docker 应用专用（docker inspect 检查容器状态）
  - 补全 8 个生命周期脚本（install/upgrade/uninstall/config × init/callback）
  - 目录布局从嵌套结构改为扁平结构（manifest/cmd/config/wizard/ui/app 直接在根）

### Changed
- `server.js` 默认绑定地址从 `127.0.0.1` 改为 `0.0.0.0`（fnOS 窗口代理需从容器外连接 8080 端口；可通过环境变量 `AURAFILE_HOST=127.0.0.1` 降级回本机模式）
- GitHub About 已设置（Description + Topics + Homepage）
- 删除旧的错误产物 `fpk.json`

## [0.1.2] - 2026-07-08

### Added
- 首次 fnOS fpk 尝试发布（zip 格式 + JSON manifest，**后被证实不符合 fnOS 规范**）
- 光匣图标（ICON.PNG 64×64 + ICON_256.PNG 256×256，柔光渐变 + 发光方盒母题）
- 关于页补全（特性列表 / MIT 许可 / 离线声明 / GitHub + 捐赠链接）

### Fixed
- CI Docker 构建 GID 冲突（node:18-alpine 内置 uid/gid 1000 与 addgroup 冲突）—— 改为复用 node 用户 + chown 后置
- 安全加固（OWASP/STRIDE 审计修复项）：Zip-Slip、路径穿越、非 root 运行等

## [0.1.1] - 2026-07-07

### Fixed
- CI 构建配置调整

## [0.1.0] - 2026-07-07

### Added
- 初始版本：Aurafile 离线 NAS 文件管理器基础功能
- Docker 化部署（Node.js + Express + better-sqlite3 FTS5 + sharp + ffmpeg）
- 基础 UI（文件列表 / 搜索 / 缩略图 / 详情面板）
