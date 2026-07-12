# Changelog

All notable changes to Aurafile (光匣) will be documented in this file.

## [0.1.13] - 2026-07-12

### Fixed
- **fnOS 桌面「窗口化打开」白屏/打不开（根本原因）**：`server.js` 之前强制 `X-Frame-Options: SAMEORIGIN`，而 fnOS 桌面窗口用 iframe 嵌入 app 时嵌入源与 app 服务**跨源**，浏览器据此拒绝渲染 iframe。已**移除该响应头**（对齐成功案例 nasdash，其不设此头），现桌面窗口可正常内嵌渲染。
- **fnOS 应用商店显示「停用」而非「打开」（根本原因）**：`fpk/cmd/main` 的 `status` 原用 `docker inspect` 探测容器状态，而 fnOS 执行生命周期脚本的环境可能无 docker socket 权限，导致 inspect 永远失败 → 永远返回「未运行」(exit 3) → 应用商店显示「停用」。已改为**直接探测已发布到宿主机的服务端口**（`wget`/`curl` 访问 `http://localhost:8018/api/health`），容器真实在跑即判定运行中；保留 docker inspect 作为兜底。

### Changed
- 前端全面「零 modal」：移除最后一个筛选弹窗（filterModal），改为文档流内联筛选栏（filterBar），所有交互均在正常文档流完成，彻底规避 fnOS iframe 的按钮事件拦截问题。（此前 v0.1.12 已内联化重命名/操作条，本次补齐筛选。）

## [0.1.12] - 2026-07-12

### Changed
- **彻底废弃 promptModal 自定义弹窗，全面改用内联交互模式**（解决 fnOS iframe 环境下按钮事件无法触发的顽固问题）：
  - **内联重命名**：选中文件 → 点"重命名" → 文件名直接变为可编辑 input（类似 macOS Finder），Enter 确认 / Escape 取消 / 失焦自动确认。不再需要任何 modal 弹窗。
  - **内联操作条**：压缩包命名、格式转换等操作改为在工具栏下方展开临时输入条（inline-action-bar），带标题 + 提示文字 + 输入框 + 确定/取消按钮。点击外部区域可关闭。
  - **零 modal 依赖**：所有用户输入交互都在正常文档流内完成，彻底规避 fnOS WebView/iframe 的 z-index 问题、透明层截获、pointer-events 异常等兼容性问题。

### Removed
- `#promptModal` 整个 HTML 元素及相关 JS 逻辑（`promptText()` 函数、三重事件绑定、事件委托兜底）全部移除
- `#promptHint`、`#promptInput`、`#promptOk`、`#promptCancel` 元素移除

### Fixed
- **fnOS 应用商店显示"停用"而非"打开"**：此问题与容器状态无关（v0.1.10/v0.1.11 日志均显示正常启动扫描）。v0.1.12 的猜测性修复（"确保 HTTP 服务稳定"）**未能彻底解决**，真正的根因与修复见 v0.1.13（cmd/main 状态探测改为端口探活）。

## [0.1.11] - 2026-07-12

### Fixed
- **输入弹窗（promptModal）按钮在 fnOS 真机 iframe 中仍无响应（v0.1.9 加固未彻底解决）**：v0.1.9 虽已加 `preventDefault` + `stopPropagation`，但 fnOS 桌面窗口的 WebView/iframe 嵌入环境中，仅靠 `onclick` 属性赋值 + 单一 click 事件仍不够可靠（可能被框架层截获、或 WebView 的 onclick setter 行为异常）。现已实施**三重事件绑定保险**：
  - `onclick` 属性赋值（原始方式）
  - `addEventListener('click', ...)` （标准 DOM 事件）
  - `addEventListener('pointerdown', ...)` + `touchend`（指针/触摸设备兜底）
  - **modal-card 事件委托**（capture 阶段拦截，作为最终保底）
  - 防重复触发锁（`resolved` 标志）
  - 延迟 focus（`requestAnimationFrame`，确保 modal 已渲染）

- **弹窗缺少操作上下文提示**：原弹窗标题只显示「输入」或「重命名为」，用户不知道当前在执行什么操作、该输入什么内容。现增加第三个参数 `hint`，每个调用点传入明确的引导文字：
  - 重命名：显示「输入新的文件/文件夹名称」，默认值填充当前文件名
  - 压缩：显示「输入压缩包名称（不需扩展名），将创建 .zip 文件」
  - 格式转换：显示「输入目标格式扩展名，如 png / webp / jpg」
  - HTML 新增 `<p id="promptHint">` 提示文字区域，带次要色样式

## [0.1.10] - 2026-07-12

### Fixed
- **容器不断重启（OOM crash loop）**：`src/indexer.js` 的 `initialScan()` 启动时无保护地全量递归遍历整个 NAS（无论数据量多大），无分批、无并发限制、无错误捕获，且 `await` 串行阻塞。大 NAS 上内存累积触发 OOM killer → 容器退出 → `restart: unless-stopped` 无限重启。已改为：分批（每批 200 文件）+ 每批 `setTimeout` 让出事件循环 + 递归深度上限 25 + 文件总数上限 50 万 + 全程 `try/catch` 隔离（扫描失败只 log，不致命）。
- **启动层崩溃隔离**：`server.js` 中 `db.init()` 与 `indexer.start()` 原本抛错即 crash。现已包 `try/catch`，确保 HTTP 服务优先起来，DB/索引失败仅记录日志，不再触发重启循环。
- **chokidar watcher 加固**：`depth` 由 99 降为 20，`start()` 内扫描与 watcher 启动均加 `try/catch` 与 `watcher.on('error', ...)`，监听失败不影响 HTTP 服务。
- **端口占用友好提示**：`app.listen` 增加 `error` 事件处理，端口被占用（如旧容器未释放 8018）时打印清晰日志而非匿名崩溃。

## [0.1.9] - 2026-07-12

### Fixed
- **输入弹窗（promptModal）确定/取消按钮无响应**：`app.js` 中 `promptText()` 的 `ok`/`cancel` 回调函数未接收 event 参数、无 `preventDefault()` + `stopPropagation()`，在 fnOS iframe 嵌入环境中点击按钮时事件被浏览器默认行为或父框架拦截，导致弹窗无法关闭、回调不执行。已加固事件处理：箭头函数接收 `e` 参数并调用 `e.preventDefault(); e.stopPropagation();`。

## [0.1.8] - 2026-07-11

### Fixed
- **关于页打开 404（自测发现 HIGH 阻塞项）**：`aboutBtn` 跳转 `/about`，但 `server.js` 仅用 `express.static` 映射真实文件、无 `/about` 路由 → `GET /about` 返回 404，关于页实际打不开。已在 `server.js` 增加显式路由 `app.get('/about', ...)` 指向 `public/about.html`，不再依赖静态中间件扩展名回退。
- **提交的 `fpk/app.tgz` 端口陈旧（自测发现 MEDIUM 项）**：仓库内 `app.tgz` 是 v0.1.5 时期的快照，compose 仍为 `8011:8011` / `PORT=8011`，与源码 `8018` 不一致。已用 `tar -czf fpk/app.tgz -C fpk/app .` 重新生成（与 CI「Generate app.tgz」步骤一致），现 compose 端口 = `8018:8018` / `PORT=8018`。CI 发布路径本就会重生成，但手动/本地打包此前会带上旧 8011 → checkport 失配 → fnOS 桌面入口不注册。

### Chore
- 删除修复前遗留的陈旧连字符图标 `app/ui/images/icon-64.png`、`icon-256.png`（未被任何代码引用，仅 `fpk/ui/images/` 下划线版生效）。
- `.gitignore` 增加 `.aurafile-data/`（运行时数据目录）。

## [0.1.7] - 2026-07-08

### Fixed
- **关于页从弹窗改为独立页面**（用户要求）：移除 `index.html` 中的 aboutModal 弹窗，新增独立的 `/about` 页面（`public/about.html`），点击 ℹ 按钮直接跳转。彻底解决 fnOS iframe 嵌入场景下弹窗关闭按钮无效的问题。
- **🎯 修复桌面图标不显示的根因——图标文件名错误**：
  - `fpk/ui/images/icon-64.png` → 重命名为 **`icon_64.png`**（连字符→下划线）
  - `fpk/ui/images/icon-256.png` → 重命名为 **`icon_256.png`**
  - **根因**：ui/config 中 icon 路径为 `images/icon_{0}.png`，fnOS 将 `{0}` 替换为 `64`/`256` 后查找 `icon_64.png`，但实际文件名使用的是**连字符** `icon-64.png`，文件找不到 → 桌面图标无法渲染。

### Changed
- **桌面入口类型改为 iframe**：`fpk/ui/config` 中 `type` 从 `"url"` 改为 `"iframe"`，应用将在 fnOS 桌面窗口内嵌加载（而非新标签页打开）。
- **X-Frame-Options 放宽为 SAMEORIGIN**：`server.js` 安全头从 `DENY` 改为 `SAMEORIGIN`，允许 fnOS 桌面窗口以 iframe 方式嵌入应用页面。

### Notes（桌面图标）
- 图标文件名修复后，**必须删除 fnOS 上的旧应用，重新导入 v0.1.7 fpk**。升级/覆盖安装不会刷新图标缓存。
- fnOS Docker 应用桌面图标消失是**已知系统问题**（论坛大量反馈：N100+16G 设备同样复现，官方确认为潜在性能导致的自启动失败）。如重导入后图标仍不稳定，可使用 [fndesk](https://github.com/IMGZCQ/fndesk) 或 [App.Bin.customIcon](https://github.com/FNOSP/App.Bin.customIcon) 等第三方工具手动添加桌面快捷方式。

## [0.1.6] - 2026-07-08

### Fixed
- **修复关于弹窗「关闭」按钮无效**：`<button>` 缺少 `type="button"` 属性。在 fnOS iframe 嵌入场景下，浏览器将按钮默认视为 `type="submit"`，触发表单提交/页面刷新导致 `hidden=true` 被回滚，弹窗无法关闭。修复：关闭按钮及所有弹窗按钮统一添加 `type="button"`；JS 事件处理增加 `e.preventDefault()` 防御。

### Changed
- **默认端口从 8011 改为 8018**（用户要求）：
  - `Dockerfile`：`EXPOSE 8018`、`PORT=8018`、healthcheck URL
  - `fpk/manifest`：`service_port = 8018`、版本 `0.1.6`
  - `fpk/app/docker/docker-compose.yaml`：端口映射 `8018:8018`、`PORT=8018`
  - `fpk/ui/config`：`port: "8018"`
  - `src/config.js`：默认 PORT 回退值 `8018`
  - `server.js` 注释同步更新

### Notes（桌面图标）
- 桌面图标不显示的根因分析：v0.1.5 安装时容器因权限问题崩溃 → fnOS `checkport` 失败 → 缓存了「启动失败」状态 → 后续容器修复后桌面入口未重新注册。
- **解决方案**：v0.1.6 需要在 fnOS 上**删除旧应用后重新导入 fpk**（非升级/覆盖安装），让 fnOS 重新执行完整的桌面注册流程。
- fpk 配置结构已与 FN-Terminal（已验证可正常显示桌面的 fnOS 应用）逐字段对齐：`desktop_applaunchname` 与 ui/config key 一致、图标路径使用 `{0}` 占位符、`type: "url"` 对独立端口访问正确。

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
