# dsh-input —— DeepSeek Harness 键鼠控制插件

让 Agent 直接操控本机键盘与鼠标：移动、点击、拖拽、滚轮、组合键、Unicode 文本输入、窗口聚焦、屏幕截图与真机自检。
配套 **前台守卫、暂停开关、审计日志、dry-run**，避免「AI 把字打进自己聊天框」这类事故。

- 仓库：<https://github.com/ABccgh/dsh-input>（0.1.0，2026-10-27 发布）
- 包名：`@local/input`，插件行 id：`input`
- 工具：**11 个 `input_*`**（见下表）
- 平台：**仅 Windows**（Windows PowerShell 5.1 + Win32 `SendInput`）；非 Windows 只提示不支持
- 运行时零外部依赖：`lib/**/*.js` 只 import `node:*` 与包内模块；helper 是纯 ASCII 的 PowerShell 脚本

---

## 1. 安装

> **从副本安装，不要从 git 工作树安装。** 安装目标会成为 profile 的 `link:` 依赖，
> git 工作树里的改动会直接影响线上插件；反过来，误删工作树也会让插件失效。

仓库是源码；实际运行的是 `%USERPROFILE%\dsh-bundles\input` 下的**安装副本**。

1. 从 GitHub 克隆（或直接使用本地仓库）：

   ```powershell
   git clone https://github.com/ABccgh/dsh-input.git
   ```

2. 复制到长期保留的安装目录：

   ```powershell
   robocopy "<仓库路径>" "$env:USERPROFILE\dsh-bundles\input" /MIR /XD .git test node_modules
   ```

   `/MIR` 会删除副本里源没有的文件，所以 `DO-NOT-DELETE.txt` 是**放在仓库里**的，同步不会把它删掉。

3. 用绝对路径安装：

   ```text
   plugin_manager  action: install_bundle  target: %USERPROFILE%\dsh-bundles\input
   ```

   管理器会自己跑包安装、写入 profile 的 `package.json` 并选中这个 bundle。
   **不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。**

4. 验证：插件列表里出现一行 `input`，模块是 `@local/input`，状态 `active`。

- 首次安装返回 `application: applied` 即生效（HMR 会激活新 bundle）。
- **改 `lib/` 代码**：重新 robocopy → **重启 DSH**（Host 会缓存已加载的 ESM 模块，关开 bundle 不会重读代码）。
- **只改 `cordis.patch.yml` 的配置值**：插件页把 `input` 关开一次即可，不必重启。
- **不要删安装目录**：profile 通过 `node_modules/@local/input` 这个 junction 指向它，删掉就等于删掉全部 `input_*` 工具，直到重新安装。目录里的 `DO-NOT-DELETE.txt` 说明了这一点。
- 卸载：`plugin_manager action: remove_bundle`（bundle 名 `@local/input`），再删掉 `dsh-bundles\input` 副本。

> 换机器时注意两点：`cordis.patch.yml` 里没有绝对路径（默认值都由代码推导），但要确认目标机有 Windows PowerShell 5.1；`robocopy` 的目标目录可以按需改名，install_bundle 传对应路径即可。

---

## 2. 工具一览

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `input_status` | 屏幕/光标/前台窗口/helper 状态/暂停/审计/权限，只读诊断 | — |
| `input_mouse_move` | 移动光标（绝对或相对），可平滑 | `x,y` 或 `dx,dy`；`durationMs`；`space` |
| `input_mouse_click` | 点击/双击/三击，可先定位 | `button`；`count`；`x,y` |
| `input_mouse_drag` | 按住拖拽 | `fromX,fromY,toX,toY`；`durationMs`；`steps` |
| `input_mouse_scroll` | 垂直/水平滚轮 | `delta`（-10..10）；`horizontal`；`x,y` |
| `input_key` | 组合键/长按/按住不放 | `keys`；`action`；`repeat`；`holdMs` |
| `input_type` | Unicode 文本输入（中文/emoji 无需输入法） | `text`；`intervalMs`；`submit` |
| `input_window_list` | 枚举可见顶层窗口 | `filter`；`limit`；`includeMinimized` |
| `input_window_focus` | 把目标窗口切到前台 | `title` / `hwnd` / `pid` 三选一 |
| `input_screenshot` | 全屏/区域截图到固定目录，配合 `read_image` | `region`；`space` |
| `input_selftest` | 真机自检：DPI、鼠标往返、点击、文本、组合键、滚轮 | `skipMouse`；`skipKeyboard` |

### 典型用法

```text
input_status                                                      # 先看屏幕与前台
input_window_list filter="记事本"                                  # 找目标窗口
input_window_focus title="记事本"                                  # 切前台
input_type text="hello 世界" submit=true                           # 输入并回车
input_key keys=["ctrl","s"]                                       # 保存
input_screenshot                                                  # 截图确认
input_selftest                                                    # 链路自检
```

- **坐标默认是物理像素**（与截图一致）；`space="logical"` 会按主屏缩放（本机 1.25×）换算。
- `input_key` 的 `keys` 是数组：`["ctrl","shift","s"]` 或单段 `["ctrl+s"]`；键名见 README 末尾。
- `input_type` 的 `\n` 发送回车、`\t` 发送 Tab；`submit=true` 末尾再按一次回车。

---

## 3. 配置

配置文件：安装副本里的 `cordis.patch.yml`（仓库里的同名文件是模板）。

| 键 | 默认 | 说明 |
|---|---|---|
| `powershellPath` | 空=自动 | Windows PowerShell 5.1 绝对路径 |
| `helperPath` | 空=包内 | helper 脚本路径；一般不用改 |
| `requestTimeoutMs` | 15000 | 单条 helper 命令超时（移动/输入会按参数自动放大） |
| `startupTimeoutMs` | 30000 | helper 冷启动超时（首调用实测约 2.7s） |
| `idleTimeoutMs` | 300000 | helper 空闲回收时间 |
| `guardSelfWindow` | true | 前台是本应用时拒绝 `input_key`/`input_type` |
| `selfWindowTitles` | `['DeepSeek Harness']` | 判定「本应用」的标题子串 |
| `pauseFile` | 空=`%TEMP%\dsh-input-pause` | 该文件存在时所有注入类工具立即拒绝 |
| `auditFile` | 空=`%LOCALAPPDATA%\dsh-input\audit.jsonl` | 审计日志（JSONL，2MB 轮转） |
| `auditEnabled` | true | 关掉后不写审计 |
| `dryRun` | false | 只返回计划，不真正注入 |
| `coordinateSpace` | physical | 默认坐标空间：physical / logical |
| `allowOutOfBounds` | false | 允许屏幕外坐标 |
| `maxTypedChars` | 4000 | `input_type` 单次最大字符数 |
| `maxKeyRepeat` | 20 | `input_key` 最大重复次数 |
| `maxMoveSteps` | 240 | 平滑移动最大步数 |
| `moveStepDelayMs` | 8 | 平滑移动每步间隔 |
| `screenshotDir` | 空=`%TEMP%\dsh-input\shots` | 截图目录 |
| `maxScreenshots` | 20 | 截图保留张数（多的按时间删除） |

配置写错不会让插件装不上：`normalizeConfig` 会把非法值回退成默认值。

---

## 4. 安全模型（重要）

这是**真实操控输入设备**的能力，请按「给 Agent 一把会动的鼠标」来理解：

1. **前台守卫**：`input_key` / `input_type` 执行前检查前台窗口。若前台是本应用（PID 属于 DSH 进程树，或标题命中 `selfWindowTitles`），直接返回 `E_SELF_FOCUS`，提示先 `input_window_focus` 切到目标窗口。鼠标移动/点击不拦（要能点自己的界面），但全部写审计。
2. **暂停开关**：创建 `%TEMP%\dsh-input-pause`（`New-Item "$env:TEMP\dsh-input-pause"`）后，所有注入/聚焦/自检立即拒绝；删掉文件恢复。`input_status` 会显示状态。这是急停开关，Node 与 helper 双重检查。
3. **审计**：每次注入/聚焦/自检写一行 JSONL（时间、工具、参数摘要、文本只留前 80 字符、结果、错误码、耗时）。写失败只记日志，不影响操作。
4. **dry-run**：`dryRun: true` 时所有工具只返回「将要做什么」，不产生任何输入，适合演示或先审阅计划。
5. **串行 + 超时**：同一时间只允许一条 helper 命令在途；超时/协议错误直接杀进程，下次调用透明重启，避免半死状态。
6. **不越权**：插件不修改系统设置、不锁屏、不关机、不读写剪贴板；截图只能写到配置目录；helper 不接收任意脚本。

### 能力边界（不假装支持）

- UAC 安全桌面、锁屏界面**无法注入**。
- 使用 Raw Input 的游戏、部分受保护内容可能忽略合成输入。
- 非提升运行的 DSH 无法向提升权限的窗口注入（本机 DSH 以管理员运行，`input_status` 会报告权限）。
- 多显示器混合 DPI 时 `logical` 坐标只按**主屏**缩放换算，属近似。
- 焦点被系统抢占时，键可能落到别的窗口——所以键入前先用 `input_window_focus` 并核对 `input_status`。

---

## 5. 实现结构

```
DO-NOT-DELETE.txt    安装目录保护标记（随仓库同步，防 /MIR 删除）
lib/
├─ index.js            插件入口：normalize → 建 session/audit → 注册 11 个工具 → effect 清理
├─ config.js           配置默认值/归一化/默认路径
├─ errors.js           错误码 → 中文提示
├─ protocol.js         base64 行协议编解码与 init 校验
├─ helper-session.js   常驻 helper：启动/串行队列/超时杀进程/崩溃重启/空闲回收
├─ keys.js             键名表与组合键解析（Node 侧，便于单测）
├─ coordinates.js      物理/逻辑坐标换算与边界校验
├─ audit.js            JSONL 审计 + 轮转
├─ tool-kit.js         本地 defineTool（零依赖）
├─ tools/              status / mouse / keyboard / window / screenshot / selftest
└─ helper/
   ├─ input-helper.ps1 常驻 PowerShell helper（纯 ASCII）
   └─ PROTOCOL.md      线路协议（Node ↔ helper 的唯一契约）
```

- helper 冷启动约 2.7s（PowerShell + Add-Type 编译 C# P/Invoke），之后每条命令毫秒级；空闲 5 分钟自动退出。
- `input-helper.ps1` 保持**纯 ASCII**：Windows PowerShell 5.1 对无 BOM 的 UTF-8 会按 ANSI 读，中文会乱码；面向用户的中文提示统一由 Node 侧生成。
- 坐标：helper 启动时 `SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，所以 `GetSystemMetrics`/`GetCursorPos`/`SetCursorPos` 都是物理像素；移动优先 `SetCursorPos`（不受鼠标加速影响），失败回退 `SendInput` 绝对坐标。

---

## 6. 测试与验证

```powershell
# 单元测试（不产生真实输入）：90 个用例
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test "test/*.test.js"

# 真机 E2E（会移动光标并复原、截图后删除、跑 selftest）
$env:DSH_INPUT_LIVE = '1'
& "...\node.exe" --test test/live.test.js
Remove-Item Env:\DSH_INPUT_LIVE
```

- `input_selftest` 是运行时的可信证据：它会在自己的临时窗口里验证鼠标往返、点击、Unicode 文本、组合键（Ctrl+S 的 KeyDown 记录）与滚轮，结束后恢复前台。
- `input_status` 在 helper 起不来时也会返回诊断（PowerShell 路径、helper 脚本、stderr 尾部），不会直接抛错。

### 本机验证记录（2026-10-27）

- 单元测试：90 个用例，**88 通过 + 2 跳过**（live 用例需 `DSH_INPUT_LIVE=1`）；live **2/2 通过**。
- 真机 `input_selftest`：**7/7**（dpi / screen / mouse-move / mouse-click / key-state / keyboard-type / wheel），
  光标往返误差 0、前台复原。
- 安全：DSH 前台时 `input_type` 被 `E_SELF_FOCUS` 拒绝；暂停文件存在时 `input_mouse_move` 被 `E_PAUSED` 拒绝；
  审计 JSONL 同时记录了成功与失败。
- 截图：1920×1080 PNG，`read_image` 可读；`input_status` 与 `input_window_list` 的坐标/句柄一致。
- 限制：单显示器验证；多屏与混合 DPI 未验证；插件页图标/标题的渲染未做视觉验证。

---

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| 首次调用很慢（约 2-3 秒） | 正常：helper 冷启动；之后 5 分钟内都很快 |
| `E_HELPER_START` | 看 `input_status` 的细节：PowerShell 路径是否存在、helper 脚本是否在安装副本里、安全软件是否拦截 |
| `E_SELF_FOCUS` | 前台是本应用；用 `input_window_focus` 切到目标窗口，或临时把 `guardSelfWindow` 设为 false |
| `E_PAUSED` | 暂停文件还在；`Remove-Item "$env:TEMP\dsh-input-pause"` |
| `E_BOUNDS` | 坐标超出屏幕；先 `input_status` 看物理尺寸 |
| 键打不进目标窗口 | 目标窗口可能未获得焦点；`input_window_list` + `input_window_focus` 后再输入 |
| 改了代码不生效 | 重启 DSH；只改配置则关开 bundle 一次 |

---

## 8. 键名表（`input_key`）

- 字母 `a`–`z`、数字 `0`–`9`、`f1`–`f24`
- 修饰键：`ctrl`（`control`）、`shift`、`alt`、`win`（`meta`/`cmd`/`super`）、`lctrl`/`rctrl`、`lshift`/`rshift`、`lalt`/`ralt`、`lwin`/`rwin`
- 编辑/导航：`enter`（`return`）、`tab`、`space`、`backspace`、`delete`（`del`）、`insert`（`ins`）、`home`、`end`、`pageup`（`pgup`）、`pagedown`（`pgdn`）、`left`/`up`/`right`/`down`、`esc`、`capslock`、`numlock`、`scrolllock`、`printscreen`、`pause`、`apps`
- 小键盘：`numpad0`–`numpad9`、`multiply`、`add`、`subtract`、`decimal`、`divide`
- 标点：`semicolon`、`equals`、`comma`、`minus`、`period`、`slash`、`backtick`、`lbracket`、`backslash`、`rbracket`、`quote`；加号写 `plus`（`+` 是组合键分隔符）
- 媒体：`volumemute`、`volumedown`、`volumeup`、`mediaplaypause`、`mediastop`、`nexttrack`、`prevtrack`

组合键规则：修饰键在前、主键在最后，一次最多 6 个键；例如 `["ctrl","shift","s"]`。

---

## 9. 许可

MIT，Copyright (c) 2026 ABccgh。见 [LICENSE](LICENSE)。
