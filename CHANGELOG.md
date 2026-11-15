# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [1.1.1] - 2026-11-15

### Fixed

- **WorkBuddy 从来没有真正被签到过**（用户反馈：不是启动即领，需要点一下）：这个界面没有固定入口，签到卡片只是侧边栏底部活动轮播里的一张，轮播还会自动切换，点 DOM 极不稳定。改为通过 CDP 调应用自己的接口 —— `wb.account.checkinStatus()` 读状态、`wb.account.checkin()` 领取（就是面板「立即领取」背后的同一个调用），再用状态复验。日志只作为拿不到接口时的兜底。
- **WorkBuddy 现在必须带 `--remote-debugging-port=9533` 启动**：已开着但没带端口的实例会被重启一次（重启前就已在运行的客户端，签到结束后保持打开，不会像脚本自己启动的那样被关掉）。
- **豆包账号列表偶尔读空**：刚启动时账号弹窗还没渲染完，旧逻辑直接降级成「只签当前账号」，另一个账号就漏签。现在会重试 3 次（每次 2.5 秒）再决定。
- **CodeArts 签到失效**（用户反馈「点了签到没反应」的一半原因）：新版「活动福利」面板把签到放在**第一项**「每日签到领100积分」，按钮文字是「每日领取」，不再是旧版藏在「已完成与已隐藏的活动」里的「签到」。旧选择器只认 `签到|立即签到|去签到|领取` 的整词按钮，于是每次都报「活动福利里没找到签到按钮」。现在改为：面板已开则不点头像；按 `.welfare-activity-item` 里含「每日签到」的项找按钮（`/领取|签到/`）；领取后该条目移入 `.welfare-hidden-section` 并显示「今日已领」，据此判定成功（必要时自动展开折叠区）。
- **已开着、但没带 `--remote-debugging-port` 的客户端会被判成「没能启动」**：这些实例根本无法用 CDP 驱动，旧逻辑却「already running, keep as is」然后干等 90 秒。现在 `run-checkin.ps1` 会探测端口（9531/9534），端口不通就重启一次客户端再签。
- **面板「立即签到」点下去像没反应**：按钮 2.5 秒后无声复位，而真正的签到要等每分钟一次的 tick、再跑 30-70 秒，期间 UI 没有任何变化。现在：
  - `run-checkin.ps1` / `checkin.mjs` / 看板服务共同维护 `logs/progress.json`（`queued → launching → app(豆包/CodeArts…) → wrapping → done`）；
  - `GET /board` 新增 `checkin`（running/stage/app/ageMs/stalled）与 `lastResults`；
  - 面板顶部实时显示「已排队 / 正在签到：豆包…」并带计时，签到期间 3 秒轮询一次；按钮保持「签到中…」直到本次结束；底部显示「上次签到 13:12：豆包 ✓ · CodeArts ✓」；
  - 排队超过 2 分钟会提示「检查计划任务 DSH-CheckinNow 是否启用」
  - `checkin-now.ps1` 改成 50 秒长轮询：点「立即签到」到真正开始实测 **0.6 秒**（原来最多要等 60 秒的分钟 tick）。

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
