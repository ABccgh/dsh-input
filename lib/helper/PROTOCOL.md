# input-helper 协议 v1

本文件是 `lib/helper/input-helper.ps1` 与 Node 侧 `lib/protocol.js` / `lib/helper-session.js` 之间的唯一契约。
改协议必须同时改两边和本文件。

## 0. 硬性约束

- helper 文件必须**纯 ASCII**（Windows PowerShell 5.1 无 BOM 时会按 ANSI 读，非 ASCII 会乱码）；用户可见的中文提示由 Node 侧按错误码生成。
- helper 只通过 **stdin/stdout** 通信，**stdout 只允许出现协议行**；诊断信息写 stderr（Node 只保留尾部用于报错）。
- 不得弹窗、不得写系统设置（锁屏/关机/剪贴板/UAC），不得启动其它进程。
- C# 由 Windows PowerShell 5.1 的 `Add-Type` 编译，语法按 **C# 5** 写（不要字符串插值、`?.`、表达式体成员、`nameof`）。

## 1. 启动方式

```
powershell.exe -NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -File "<abs>\input-helper.ps1"
```

Node 以 `spawn` 启动，stdin/stdout/stderr 均为 pipe，`windowsHide: true`。

## 2. 线路编码

每行一个消息：`base64( UTF-8( JSON ) )` + `\n`。

- 读：`$line = [Console]::In.ReadLine()`；`$null` = EOF。
- 解码：`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))` → `ConvertFrom-Json`。
- 编码：`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))` → `[Console]::Out.WriteLine($b64)`。
- 禁止 `Write-Output` / `Write-Host`；它们会污染 stdout。
- base64 是 ASCII，天然规避 PowerShell 5.1 管道编码问题。

## 3. 启动流程

1. `$ErrorActionPreference = 'Stop'`。
2. `Add-Type -AssemblyName System.Windows.Forms`、`System.Drawing`，再 `Add-Type -TypeDefinition` 编译类 `DshInput`。
   失败：输出一条 `id=null` 的 `E_HELPER_START` 错误响应后 `exit 1`。
3. `SetThreadDpiAwarenessContext(-4)`（PER_MONITOR_AWARE_V2），记录成功与否（`dpiAware`）。
4. 读第一行，必须是 `op=init`。解析失败或 op 不对：输出 `id=null` 的 `E_HELPER_START` 后 `exit 1`。
5. 记录启动时刻；构建 self PID 集合 = 本进程 PID + 最多 8 层父进程（`Get-CimInstance Win32_Process -Filter "ProcessId=<id>"`，失败则忽略）+ `init.selfPids`。
6. 输出 init 成功响应，进入命令循环。

## 4. init

请求：

```json
{"id":1,"op":"init","args":{
  "pauseFile":"C:\\Users\\x\\AppData\\Local\\Temp\\dsh-input-pause",
  "guardSelf":true,
  "selfPids":[5540,17000],
  "selfTitles":["DeepSeek Harness"],
  "allowOutOfBounds":false,
  "stepDelayMs":8
}}
```

`pauseFile` 为空字符串 = 不检查暂停文件。

成功响应 `result`：

```json
{
  "helperVersion": "1.0.0",
  "protocol": 1,
  "pid": 12345,
  "psVersion": "5.1.26100.9711",
  "elevated": true,
  "dpiAware": true,
  "monitorCount": 1,
  "screen": {
    "physical": {"x":0,"y":0,"width":1920,"height":1080},
    "logical": {"width":1536,"height":864},
    "scale": 1.25
  },
  "cursor": {"x":960,"y":540},
  "os": {"caption":"Microsoft Windows 11 ...","build":"26300"},
  "selfPids": [5540, 17000, 12345]
}
```

- `screen.physical` 是**虚拟屏**（多屏时 x/y 可为负）。
- `scale = GetDpiForSystem()/96`（PMv2 线程下）；`logical = physical/scale`，仅主屏语义。
- `elevated` 由 WindowsIdentity/WindowsPrincipal 判断。

## 5. 命令信封

请求：`{"id":2,"op":"move","args":{...}}`
成功：`{"id":2,"ok":true,"result":{...}}`
失败：`{"id":2,"ok":false,"error":{"code":"E_BOUNDS","message":"target outside virtual screen"}}`

- `error.message` 用**英文**（纯 ASCII）；Node 按 `code` 映射中文提示。
- 未知 op → `E_PROTOCOL`；`args` 缺失按 `{}`。
- 单条命令内部异常必须 try/catch 成 `E_INPUT_FAILED`，**不得退出进程**。
- 无法解析的输入：`id=null` 的错误响应，继续循环。

## 6. 公共规则

- **暂停**：除 `status` / `windows` / `screenshot` / `ping` / `quit` 外，执行前检查 `pauseFile` 是否存在；存在 → `E_PAUSED`。
- **自我守卫**：`key`（action=press/down）与 `type` 在 `guardSelf=true` 时检查前台窗口：
  PID ∈ selfPids，或标题包含 selfTitles 任一项 → `E_SELF_FOCUS`。
  **action=up 不检查**（保证键能松开）。
- **坐标**：整数、物理像素；不在 `screen.physical` 内且 `allowOutOfBounds=false` → `E_BOUNDS`。
- **返回值检查**：`SetCursorPos`/`SendInput` 失败 → `E_INPUT_FAILED`。

## 7. op 表

### ping
args `{}` → `{"pong":true,"uptimeMs":1234}`

### status
args `{}` →

```json
{
  "helperVersion":"1.0.0","protocol":1,"pid":123,"psVersion":"5.1...","elevated":true,
  "dpiAware":true,"monitorCount":1,
  "screen":{ "...同 init..." },
  "cursor":{"x":100,"y":200},
  "foreground":{"hwnd":7341494,"pid":5540,"title":"...","processName":"DeepSeek Harness",
                "className":"Chrome_WidgetWin_1","rect":{"x":0,"y":0,"width":1920,"height":1080},
                "isSelf":true,"minimized":false},
  "paused":false,
  "pauseFile":"C:\\...\\dsh-input-pause",
  "pressedKeys":[17],
  "pressedButtons":[],
  "uptimeMs":1234,
  "os":{"caption":"...","build":"26300"}
}
```

前台取不到时：`{"hwnd":0,"pid":0,"title":"","processName":"","className":"","rect":{"x":0,"y":0,"width":0,"height":0},"isSelf":false,"minimized":false}`。

### move
args `{x?,y?,dx?,dy?,durationMs?,steps?}`

- `(x,y)` 与 `(dx,dy)` 二选一；都给或都不给 → `E_BAD_ARGS`。
- `durationMs` 0..5000（默认 0）；`steps` 1..500（默认：durationMs>0 ? 30 : 1）。
- 目标越界检查。平滑移动 = 分 `steps` 次 `SetCursorPos` + `Sleep(stepDelayMs)`。
- result `{"from":{"x":..,"y":..},"target":{"x":..,"y":..},"actual":{"x":..,"y":..},"steps":30}`

### click
args `{button?:"left"|"right"|"middle", count?:1..3, intervalMs?:0..500, x?,y?}`

- 默认 `left` / `1` / `40`。
- 有 `x,y` → 先 `SetCursorPos`，`Sleep 10`。
- 每次 down+up，间隔 `intervalMs`；用 `SendInput`。
- result `{"button":"left","count":1,"position":{"x":..,"y":..},"actual":{"x":..,"y":..}}`

### drag
args `{fromX,fromY,toX,toY,button?,durationMs?,steps?}`

- 默认 `left` / 300 / 40；两个点都必须在屏内。
- `SetCursorPos(from)` → `Sleep 10` → down → 线性插值分 `steps` 次移动 + `Sleep(stepDelayMs)` → `Sleep 10` → up。
- **up 必须放 finally**：中途异常也要松开。
- result `{"from":{...},"to":{...},"actual":{...},"steps":40}`

### wheel
args `{delta:-10..10, horizontal?:false, x?,y?}`

- 有 `x,y` 先定位。
- `SendInput` `MOUSEEVENTF_WHEEL` / `MOUSEEVENTF_HWHEEL`，`mouseData = delta*120`。
- result `{"delta":-3,"horizontal":false,"position":{"x":..,"y":..}}`

### key
args `{"keys":[{"vk":17,"extended":false}],"action?":"press|down|up","repeat?":1..20,"holdMs?":0..2000,"delayMs?":0..1000}`

- `keys` 非空、最多 6 个，`vk` 1..255。
- `press`：`repeat` 次［按下（给定顺序）→ `Sleep holdMs` → 抬起（倒序）→ `Sleep delayMs`］。
- `down`：全部按下，记入 `pressedKeys`（去重）。
- `up`：倒序抬起，从 `pressedKeys` 移除。
- 守卫：`press`/`down` 检查；`up` 不检查。
- result `{"keys":[17,83],"action":"press","repeat":1}`

### type
args `{"text":"hello","intervalMs?":0..200,"submit?":false}`

- 守卫检查。
- 文本处理：`\r\n` 当一个 `\n`；单独的 `\r` 也当 `\n`；`\n` → VK_RETURN(0x0D) down+up；`\t` → VK_TAB(0x09)；其余按 UTF-16 code unit 用 `KEYEVENTF_UNICODE` 发送（代理对自然拆成两个 code unit，顺序发送）。
- 字符间 `Sleep intervalMs`。
- `submit` → 末尾再发一次 VK_RETURN。
- 性能要求：300 字符、`intervalMs=0` 时 < 1.5s（批量打包 INPUT 数组，每批 ≤128 事件）。
- result `{"chars":5,"typed":5,"submitted":false}`（`typed` = 实际发送的 unicode code unit 数）。

### windows
args `{"filter?":"","limit?":1..100,"includeMinimized?":true}`

- `EnumWindows`：`IsWindowVisible` 为真、标题非空；`includeMinimized=false` 时排除 `IsIconic`。
- `filter` 对标题做不区分大小写的子串过滤。
- 排序：前台窗口第一，其余按 `pid`、`title` 升序。
- result `{"total":12,"windows":[{"hwnd":123,"title":"x","pid":1,"processName":"a.exe","className":"C","rect":{"x":0,"y":0,"width":800,"height":600},"foreground":true,"minimized":false,"self":false}]}`
  （`total` = limit 之前的过滤后数量；`self` 语义同守卫。）

### focus
args `{"hwnd?":123,"title?":"记事本","pid?":1234,"exact?":false}`

- 优先 hwnd > title > pid；都没有 → `E_BAD_ARGS`；找不到 → `E_WINDOW_NOT_FOUND`。
- `exact=true` 标题全等，否则包含（不区分大小写）；多个命中取第一个。
- 最小化 → `ShowWindow(SW_RESTORE)`；`Sleep 50`。
- 置前：`SetForegroundWindow` → 失败用 `AttachThreadInput` 重试 → 仍失败先 `SendInput` 一次 Alt 按下+抬起再重试。
- 每次后 `Sleep 100` 并校验 `GetForegroundWindow() == hwnd`。
- result `{"ok":true,"target":{...},"previous":{...},"current":{...},"attempts":3}`；置前失败 `ok:false`（不抛错），`hint` 给英文原因。

### screenshot
args `{"path":"C:\\...\\shot.png","region?":{"x":0,"y":0,"width":800,"height":600}}`

- `path` 绝对路径；helper 直接写文件（目录由 Node 保证存在）。
- `region` 缺省 = `screen.physical`；越界 → `E_BOUNDS`。
- GDI `CopyFromScreen` → `Bitmap` → `Save(path, Png)`。
- result `{"path":"...","width":800,"height":600,"bytes":12345,"region":{...}}`
- 失败 → `E_SCREENSHOT_FAILED`。

### selftest
args `{"skipMouse?":false,"skipKeyboard?":false,"text?":"dsh input self-test 123"}`

返回 `{"ok":true,"checks":[{"name":"dpi","status":"ok","detail":"..."}]}`，`status` ∈ `ok|skip|fail`。

依次执行（任何窗口都要 finally 关闭，前台 finally 恢复）：

1. `dpi`：`dpiAware=true` 且 `scale>0`。
2. `screen`：`physical` 宽高 > 0。
3. `mouse-move`（skipMouse 则 skip）：保存光标 → 移到屏幕中心 → 回读误差 ≤1 → **复原** → 回读误差 ≤1。
4. `mouse-click`（skipMouse 则 skip）：创建一个 300×220、居中、含 `Button` 的 WinForms 窗口；`Show()`+`Activate()`+`SetForegroundWindow`；把按钮矩形换算成屏幕坐标后 `SendInput` 点击；按钮 Click 计数 +1；关闭并恢复原前台。激活失败 → `skip`（detail 说明）；点击成功 → `ok`。
5. `key-state`（skipKeyboard 则 skip）：`SendInput VK_F24(0x87)` down → `GetAsyncKeyState(0x87) & 0x8000` → up。
6. `keyboard-type`（skipKeyboard 则 skip）：另一个 WinForms 窗口 + `TextBox`；激活后把 `text` 发进去；读回 `TextBox.Text` 全等 → `ok`；再发 `Ctrl+A` 校验 `SelectionLength == text.Length`；关闭并恢复前台。
7. `wheel`（skipMouse 则 skip）：窗口 + `Panel(AutoScroll=true)` + 高子控件；聚焦 Panel；滚轮 `-3`；`VerticalScroll.Value > 0` → `ok`。

顶层 `ok` = 没有 `fail`（`skip` 不算失败）。

### quit
args `{}` → 释放 `pressedKeys` / `pressedButtons` → 响应 `{"ok":true}` → `exit 0`。

## 8. 错误码

| code | 语义 |
|---|---|
| `E_PAUSED` | 暂停文件存在 |
| `E_SELF_FOCUS` | 前台是本应用，拒绝注入按键 |
| `E_BOUNDS` | 坐标越界 |
| `E_BAD_ARGS` | 参数缺失/互斥/越界 |
| `E_WINDOW_NOT_FOUND` | 找不到目标窗口 |
| `E_INPUT_FAILED` | SendInput/SetCursorPos/置前失败 |
| `E_SCREENSHOT_FAILED` | 截图失败 |
| `E_PROTOCOL` | 未知 op / 消息不可解析 |
| `E_HELPER_START` | 启动期致命错误 |
| `E_UNSUPPORTED` | 平台不支持 |

## 9. C# 要求（类 `DshInput`）

至少封装：

- 输入：`SendKey(int vk, bool extended, bool up)`、`SendUnicode(int codeUnit, bool up)`、`SendMouseButton(int button, bool down)`、`SendWheel(int delta, bool horizontal)`、批量 `SendInputs(INPUT[] inputs)`。
- 光标：`SetCursorPos(int x,int y)`、`GetCursorPos`、`VirtualScreen(out int x,out int y,out int w,out int h)`。
- 屏幕：`SetThreadDpiAwarenessContext(IntPtr)`、`GetDpiForSystem()`、`GetSystemMetrics(SM_*)`。
- 窗口：`GetForegroundWindow`、`GetWindowThreadProcessId`、`GetWindowTextW`、`GetClassNameW`、`GetWindowRect`、`EnumWindows`、`IsWindowVisible`、`IsIconic`、`ShowWindow`、`SetForegroundWindow`、`AttachThreadInput`、`GetCurrentThreadId`、`QueryFullProcessImageNameW`、`GetAsyncKeyState`、`GetDoubleClickTime`。
- `INPUT` 结构体必须按 x64 正确布局（union 32 字节，`Marshal.SizeOf(typeof(INPUT))` 用于 `SendInput` 的 cbSize）；否则 `SendInput` 返回 0。

## 10. 稳定性

- 循环内单条命令异常不得退出进程。
- stdin EOF → 释放所有按下的键与鼠标键后退出。
- 空闲不自杀（生命周期由 Node 控制：超时杀进程 / `quit`）。
- 不写 stdout 非协议内容；不创建计划外的持久文件。
