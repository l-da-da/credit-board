# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [1.1.0] - 2026-11-14

### Added

- 看板**账号校验**：在 `auto-checkin/config.json` 配置 `expectedAccounts` 后，采集余额时会顺带读出 WorkBuddy / CodeArts 当前登录账号并显示在看板上；与期望值不一致时该行标红并提示 ⚠。不配置则只显示、不比对。
- README 增加 SVG 示意面板（`docs/board.svg`）、dsh-plugin 收录徽章与 CLI 安装命令。
- 本 CHANGELOG 与 GitHub Issue 模板（bug / feature）。
- `DSH-CheckinNow` / `DSH-CreditCollect` 增加每分钟触发器：作为看板服务请求（flag 文件）的消费者。

### Fixed

- **面板「刷新余额 / 立即签到」此前从未真正可用**：看板服务是按需启动的计划任务进程，从它 spawn 的 `schtasks /run` 实测必败（ERROR_PATH_NOT_FOUND），spawn powershell 后其内部任务注册也会被拒绝。修复：服务进程只写 `refresh.flag` / `force.flag`，由带每分钟触发器的两个任务在可靠的日历触发上下文里消费（≤60s 内开始）。
- 任务注册从 `schtasks /create` 改为 Schedule.Service COM API（`Register-ScheduledTask`），服务上下文里也能工作。
- 移除 `POST /config` 里冗余的任务重注册：签到时间由每次轮询读取 `config.json` 即时生效（旧路径在服务上下文里报「拒绝访问」且从未成功过）。
- **计划任务的 PowerShell 动作会闪/常驻控制台窗口**：任务计划程序不隐藏交互会话里的控制台程序，每分钟 tick 时尤其明显。全部任务动作改经 `hidden-tick.vbs`（wscript 隐藏启动，等待完成并转发退出码，全程无窗口）；看板服务经 `wscript → powershell → node` 三级链运行（部分机器的安全策略会挂起 wscript 直接启动 node，powershell 桥接绕开）。
- `install-board.ps1` 重启看板服务前先清理残留的 node 进程，避免旧实例占用 47122 端口导致新实例静默退出（EADDRINUSE）。
- 源码 `plugin/cordis.patch.yml` 的遗留 `port: 47121` 统一为 47122（插件客户端实际访问的是硬编码 47122，此前无实际影响）。
- README 的任务清单与卸载命令补全为实际的 5 个计划任务。
- DSH 插件元数据补齐 CodeArts：`package.json` 版本升至 1.1.0，`locale/*` 与 `docs/DETAIL.md` 不再写「三家客户端」。

## [1.0.0] - 2026-11-14

### Added

- 首次开源发布（MIT）。
- 每日自动签到：WorkBuddy（启动即领）、豆包（多账号自动切换）、CodeArts（头像 → 活动福利）。
- DeepSeek Harness 侧边栏「💰 额度」看板：余额、今日签到状态、豆包额度进度条、刷新余额 / 立即签到按钮、签到时间与「签到后保留客户端」设置。
- 余额采集服务（最小化读客户端 UI，失败保留旧值）与看板数据服务（127.0.0.1:47122，仅回环）。
- 一键安装 / 卸载脚本与计划任务（15 分钟轮询、成功自暂停、次日 00:05 恢复）。
