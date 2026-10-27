# dsh-input helper: persistent stdin/stdout base64-JSON mouse/keyboard injector.
# Target runtime: Windows PowerShell 5.1 (x64), launched by lib/helper-session.js.
# Contract: lib/helper/PROTOCOL.md (protocol v1). This file must stay pure ASCII.

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- state ----

$script:HelperVersion = '1.0.0'
$script:ProtocolVersion = 1
$script:Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$script:PressedKeys = New-Object System.Collections.ArrayList
$script:PressedButtons = New-Object System.Collections.ArrayList
$script:SelfPids = New-Object System.Collections.ArrayList
$script:SelfTitles = @()

$script:PauseFile = ''
$script:GuardSelf = $true
$script:AllowOutOfBounds = $false
$script:StepDelayMs = 8

$script:DpiAware = $false
$script:Dpi = 96
$script:Scale = 1.0
$script:ScreenX = 0
$script:ScreenY = 0
$script:ScreenW = 0
$script:ScreenH = 0
$script:LogicalW = 0
$script:LogicalH = 0
$script:MonitorCount = 1
$script:Elevated = $false
$script:OsCaption = ''
$script:OsBuild = ''
$script:InputSize = 0

# --------------------------------------------------------- wire protocol ----

function Write-RawLine {
    param([string]$Text)
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

function Send-JsonMessage {
    param($Message)
    $json = ConvertTo-Json -InputObject $Message -Compress -Depth 12
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $b64 = [Convert]::ToBase64String($bytes)
    Write-RawLine $b64
}

function ConvertTo-AsciiMessage {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $clean = [regex]::Replace($Text, '[^\x20-\x7E]', '?')
    if ($clean.Length -gt 400) { $clean = $clean.Substring(0, 400) }
    return $clean
}

function Send-ErrorResponse {
    param($Id, [string]$Code, [string]$Message)
    $msg = ConvertTo-AsciiMessage $Message
    $obj = @{
        id = $Id
        ok = $false
        error = @{ code = $Code; message = $msg }
    }
    Send-JsonMessage $obj
}

function Read-RequestLine {
    $line = $null
    try {
        $line = [Console]::In.ReadLine()
    } catch {
        return $null
    }
    if ($null -eq $line) { return $null }
    $line = $line.Trim()
    if ($line.Length -eq 0) { return @{ __bad = $true } }
    try {
        $bytes = [Convert]::FromBase64String($line)
        $json = [Text.Encoding]::UTF8.GetString($bytes)
        $obj = ConvertFrom-Json -InputObject $json
        if ($null -eq $obj) { return @{ __bad = $true } }
        return $obj
    } catch {
        return @{ __bad = $true }
    }
}

# ---------------------------------------------------------- error objects ----

function New-HelperException {
    param([string]$Code, [string]$Message)
    $ex = New-Object System.Exception($Message)
    $ex.Data['dshCode'] = $Code
    return $ex
}

function Throw-Helper {
    param([string]$Code, [string]$Message)
    throw (New-HelperException $Code $Message)
}

function Get-HelperErrorCode {
    param($Exception)
    $scan = $Exception
    $depth = 0
    while ($null -ne $scan -and $depth -lt 6) {
        try {
            if ($null -ne $scan.Data -and $scan.Data.Contains('dshCode')) {
                return [string]$scan.Data['dshCode']
            }
        } catch { }
        $scan = $scan.InnerException
        $depth++
    }
    return 'E_INPUT_FAILED'
}

# --------------------------------------------------------------- args ----

function Get-ArgValue {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $null }
    try {
        $prop = $Obj.PSObject.Properties[$Name]
        if ($null -eq $prop) { return $null }
        return $prop.Value
    } catch {
        return $null
    }
}

function Test-HasArg {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $false }
    try {
        return ($null -ne $Obj.PSObject.Properties[$Name])
    } catch {
        return $false
    }
}

function ConvertTo-IntValue {
    param($Value, [string]$Name)
    if ($null -eq $Value) { Throw-Helper 'E_BAD_ARGS' ('invalid ' + $Name) }
    if ($Value -is [bool]) { Throw-Helper 'E_BAD_ARGS' ('invalid ' + $Name) }
    if ($Value -is [int]) { return [int]$Value }
    if ($Value -is [long]) {
        if ($Value -lt [int]::MinValue -or $Value -gt [int]::MaxValue) {
            Throw-Helper 'E_BAD_ARGS' ('out of range: ' + $Name)
        }
        return [int]$Value
    }
    if ($Value -is [double]) {
        if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) { Throw-Helper 'E_BAD_ARGS' ('invalid ' + $Name) }
        if ($Value -ne [Math]::Floor($Value)) { Throw-Helper 'E_BAD_ARGS' ('not an integer: ' + $Name) }
        if ($Value -lt ([double][int]::MinValue) -or $Value -gt ([double][int]::MaxValue)) {
            Throw-Helper 'E_BAD_ARGS' ('out of range: ' + $Name)
        }
        return [int]$Value
    }
    if ($Value -is [string]) {
        $parsed = 0
        if ([int]::TryParse([string]$Value, [ref]$parsed)) { return $parsed }
        Throw-Helper 'E_BAD_ARGS' ('invalid integer: ' + $Name)
    }
    Throw-Helper 'E_BAD_ARGS' ('invalid ' + $Name)
}

function Get-IntArg {
    param($Obj, [string]$Name, [bool]$Required, [int]$Default, [int]$Min, [int]$Max)
    if (-not (Test-HasArg $Obj $Name)) {
        if ($Required) { Throw-Helper 'E_BAD_ARGS' ('missing ' + $Name) }
        return $Default
    }
    $value = ConvertTo-IntValue (Get-ArgValue $Obj $Name) $Name
    if ($value -lt $Min -or $value -gt $Max) {
        Throw-Helper 'E_BAD_ARGS' ('out of range: ' + $Name)
    }
    return $value
}

function Get-RequiredIntArg {
    param($Obj, [string]$Name)
    if (-not (Test-HasArg $Obj $Name)) { Throw-Helper 'E_BAD_ARGS' ('missing ' + $Name) }
    return ConvertTo-IntValue (Get-ArgValue $Obj $Name) $Name
}

function Get-BoolArg {
    param($Obj, [string]$Name, [bool]$Default)
    if (-not (Test-HasArg $Obj $Name)) { return $Default }
    $value = Get-ArgValue $Obj $Name
    if ($null -eq $value) { return $Default }
    if ($value -is [bool]) { return [bool]$value }
    if ($value -is [int] -or $value -is [long]) { return (([long]$value) -ne 0) }
    if ($value -is [string]) {
        $text = ([string]$value).ToLowerInvariant()
        if ($text -eq 'true' -or $text -eq '1') { return $true }
        if ($text -eq 'false' -or $text -eq '0') { return $false }
    }
    Throw-Helper 'E_BAD_ARGS' ('invalid boolean: ' + $Name)
}

function Get-StringArg {
    param($Obj, [string]$Name, [bool]$Required, [string]$Default)
    if (-not (Test-HasArg $Obj $Name)) {
        if ($Required) { Throw-Helper 'E_BAD_ARGS' ('missing ' + $Name) }
        return $Default
    }
    $value = Get-ArgValue $Obj $Name
    if ($null -eq $value) {
        if ($Required) { Throw-Helper 'E_BAD_ARGS' ('missing ' + $Name) }
        return $Default
    }
    if (-not ($value -is [string])) { Throw-Helper 'E_BAD_ARGS' ('invalid string: ' + $Name) }
    return [string]$value
}

function Get-ButtonArg {
    param($Obj)
    $value = Get-ArgValue $Obj 'button'
    if ($null -eq $value) { return @{ name = 'left'; index = 0 } }
    if (-not ($value -is [string])) { Throw-Helper 'E_BAD_ARGS' 'button must be a string' }
    $text = ([string]$value).ToLowerInvariant()
    if ($text -eq 'left') { return @{ name = 'left'; index = 0 } }
    if ($text -eq 'right') { return @{ name = 'right'; index = 1 } }
    if ($text -eq 'middle') { return @{ name = 'middle'; index = 2 } }
    Throw-Helper 'E_BAD_ARGS' ('invalid button: ' + $text)
}

# ----------------------------------------------------------- primitives ----

function Wait-Ms {
    param([int]$Ms)
    if ($Ms -gt 0) { Start-Sleep -Milliseconds $Ms }
}

function Get-CursorXY {
    $point = [DshInput]::Cursor()
    if ($null -eq $point -or $point.Length -lt 2) {
        Throw-Helper 'E_INPUT_FAILED' 'GetCursorPos failed'
    }
    return @{ x = [int]$point[0]; y = [int]$point[1] }
}

function Set-CursorXY {
    param([long]$X, [long]$Y)
    if ($X -lt [int]::MinValue -or $X -gt [int]::MaxValue) {
        Throw-Helper 'E_BAD_ARGS' 'x coordinate out of integer range'
    }
    if ($Y -lt [int]::MinValue -or $Y -gt [int]::MaxValue) {
        Throw-Helper 'E_BAD_ARGS' 'y coordinate out of integer range'
    }
    [DshInput]::MoveCursor([int]$X, [int]$Y)
}

function Test-InBounds {
    param([long]$X, [long]$Y)
    if ($script:AllowOutOfBounds) { return $true }
    if ($X -lt ([long]$script:ScreenX)) { return $false }
    if ($Y -lt ([long]$script:ScreenY)) { return $false }
    if ($X -ge (([long]$script:ScreenX) + ([long]$script:ScreenW))) { return $false }
    if ($Y -ge (([long]$script:ScreenY) + ([long]$script:ScreenH))) { return $false }
    return $true
}

function Assert-InBounds {
    param([long]$X, [long]$Y)
    if (-not (Test-InBounds $X $Y)) {
        Throw-Helper 'E_BOUNDS' ('target outside virtual screen: ' + $X + ',' + $Y)
    }
}

function Test-Paused {
    if ([string]::IsNullOrEmpty($script:PauseFile)) { return $false }
    try {
        return (Test-Path -LiteralPath $script:PauseFile)
    } catch {
        return $false
    }
}

function Test-SelfWindow {
    param([long]$Hwnd, [int]$ProcessId, [string]$Title)
    if ($ProcessId -gt 0) {
        foreach ($known in $script:SelfPids) {
            if ([int]$known -eq $ProcessId) { return $true }
        }
    }
    if (-not [string]::IsNullOrEmpty($Title)) {
        foreach ($needle in $script:SelfTitles) {
            $text = [string]$needle
            if ([string]::IsNullOrEmpty($text)) { continue }
            try {
                if ($Title.IndexOf($text, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
            } catch { }
        }
    }
    return $false
}

function Assert-NotSelfFocus {
    $hwnd = [DshInput]::GetForegroundWindowValue()
    if ($hwnd -eq 0) { return }
    $processId = [int][DshInput]::WindowPid($hwnd)
    $title = [DshInput]::WindowTitle($hwnd)
    if (Test-SelfWindow $hwnd $processId $title) {
        Throw-Helper 'E_SELF_FOCUS' ('foreground window belongs to the harness: ' + $title)
    }
}

function New-ScreenInfo {
    return @{
        physical = @{
            x = [int]$script:ScreenX
            y = [int]$script:ScreenY
            width = [int]$script:ScreenW
            height = [int]$script:ScreenH
        }
        logical = @{
            width = [int]$script:LogicalW
            height = [int]$script:LogicalH
        }
        scale = [double]$script:Scale
    }
}

function Get-OsInfo {
    $caption = ''
    $build = ''
    try {
        $key = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        $caption = [string]$key.ProductName
        $build = [string]$key.CurrentBuild
    } catch { }
    if ([string]::IsNullOrEmpty($build)) {
        try { $build = [string][Environment]::OSVersion.Version.Build } catch { $build = '' }
    }
    if ([string]::IsNullOrEmpty($caption)) {
        try { $caption = [string][Environment]::OSVersion.VersionString } catch { $caption = 'Windows' }
    }
    return @{ caption = $caption; build = $build }
}

function Get-ElevatedFlag {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-SelfProcessIds {
    param($ExtraPids)
    $ids = New-Object System.Collections.ArrayList
    $ownPid = [int]$PID
    [void]$ids.Add($ownPid)
    $parents = @{}
    try {
        $procs = Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop
        foreach ($procInfo in $procs) {
            $procId = [int]$procInfo.ProcessId
            $parentId = [int]$procInfo.ParentProcessId
            if ($procId -gt 0) { $parents[$procId] = $parentId }
        }
    } catch { }
    $current = $ownPid
    for ($i = 0; $i -lt 8; $i++) {
        if (-not $parents.ContainsKey($current)) { break }
        $parentPid = [int]$parents[$current]
        if ($parentPid -le 0 -or $parentPid -eq $current) { break }
        if ($ids.Contains($parentPid)) { break }
        [void]$ids.Add($parentPid)
        $current = $parentPid
    }
    if ($null -ne $ExtraPids) {
        foreach ($raw in @($ExtraPids)) {
            if ($null -eq $raw) { continue }
            $value = 0
            if ([int]::TryParse([string]$raw, [ref]$value)) {
                if ($value -gt 0 -and -not $ids.Contains($value)) { [void]$ids.Add($value) }
            }
        }
    }
    return $ids
}

function Initialize-Helper {
    param($A)
    $script:PauseFile = Get-StringArg $A 'pauseFile' $false ''
    $script:GuardSelf = Get-BoolArg $A 'guardSelf' $true
    $script:AllowOutOfBounds = Get-BoolArg $A 'allowOutOfBounds' $false
    $script:StepDelayMs = Get-IntArg $A 'stepDelayMs' $false 8 0 1000

    $titles = New-Object System.Collections.ArrayList
    $rawTitles = Get-ArgValue $A 'selfTitles'
    if ($null -ne $rawTitles) {
        foreach ($rawTitle in @($rawTitles)) {
            if ($null -eq $rawTitle) { continue }
            $text = [string]$rawTitle
            if ($text.Length -gt 0) { [void]$titles.Add($text) }
        }
    }
    $script:SelfTitles = $titles.ToArray()

    $extraPids = Get-ArgValue $A 'selfPids'
    $script:SelfPids = Get-SelfProcessIds $extraPids
}

function Build-InitResult {
    $pids = New-Object System.Collections.ArrayList
    foreach ($known in $script:SelfPids) { [void]$pids.Add([int]$known) }
    return @{
        helperVersion = $script:HelperVersion
        protocol = $script:ProtocolVersion
        pid = [int]$PID
        psVersion = $PSVersionTable.PSVersion.ToString()
        elevated = [bool]$script:Elevated
        dpiAware = [bool]$script:DpiAware
        monitorCount = [int]$script:MonitorCount
        screen = New-ScreenInfo
        cursor = Get-CursorXY
        os = @{ caption = $script:OsCaption; build = $script:OsBuild }
        selfPids = $pids
    }
}

# -------------------------------------------------------- pressed state ----

function Add-PressedKey {
    param([int]$Vk)
    if (-not $script:PressedKeys.Contains($Vk)) { [void]$script:PressedKeys.Add($Vk) }
}

function Remove-PressedKey {
    param([int]$Vk)
    if ($script:PressedKeys.Contains($Vk)) { [void]$script:PressedKeys.Remove($Vk) }
}

function Add-PressedButton {
    param([string]$Name)
    if (-not $script:PressedButtons.Contains($Name)) { [void]$script:PressedButtons.Add($Name) }
}

function Remove-PressedButton {
    param([string]$Name)
    if ($script:PressedButtons.Contains($Name)) { [void]$script:PressedButtons.Remove($Name) }
}

function Release-All {
    $keys = @($script:PressedKeys)
    for ($i = $keys.Count - 1; $i -ge 0; $i--) {
        try { [DshInput]::SendKey([int]$keys[$i], $false, $true) } catch { }
    }
    $script:PressedKeys.Clear()
    $buttons = @($script:PressedButtons)
    for ($i = $buttons.Count - 1; $i -ge 0; $i--) {
        try {
            $name = [string]$buttons[$i]
            $index = 0
            if ($name -eq 'right') { $index = 1 }
            if ($name -eq 'middle') { $index = 2 }
            [DshInput]::SendMouseButton($index, $false)
        } catch { }
    }
    $script:PressedButtons.Clear()
}

function Send-KeySequence {
    param($VkList, $ExtList, [bool]$Up)
    $count = $VkList.Count
    if ($count -le 0) { return }
    $vks = New-Object 'int[]' $count
    $extended = New-Object 'int[]' $count
    $upFlags = New-Object 'int[]' $count
    for ($i = 0; $i -lt $count; $i++) {
        $index = $i
        if ($Up) { $index = $count - 1 - $i }
        $vks[$i] = [int]$VkList[$index]
        $extended[$i] = 0
        if ([bool]$ExtList[$index]) { $extended[$i] = 1 }
        if ($Up) { $upFlags[$i] = 1 }
    }
    [DshInput]::SendKeyList($vks, $extended, $upFlags)
}

function ConvertTo-NormalizedText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $normalized = $Text -replace "`r`n", "`n"
    $normalized = $normalized -replace "`r", "`n"
    return $normalized
}

function Send-TextRaw {
    param([string]$Text, [int]$IntervalMs, [bool]$Submit)
    $normalized = ConvertTo-NormalizedText $Text
    $typed = 0
    if ($normalized.Length -gt 0) {
        $typed = [int][DshInput]::SendTextUnicode($normalized, $IntervalMs)
    }
    if ($Submit) {
        [DshInput]::SendKey(0x0D, $false, $false)
        [DshInput]::SendKey(0x0D, $false, $true)
    }
    return @{ chars = [int]$normalized.Length; typed = [int]$typed; submitted = [bool]$Submit }
}

# ------------------------------------------------------------- windows ----

function Get-WindowObject {
    param([long]$Hwnd)
    if ($Hwnd -eq 0) {
        return @{
            hwnd = 0
            title = ''
            pid = 0
            processName = ''
            className = ''
            rect = @{ x = 0; y = 0; width = 0; height = 0 }
            foreground = $false
            minimized = $false
            self = $false
        }
    }
    $processId = [int][DshInput]::WindowPid($Hwnd)
    $title = [DshInput]::WindowTitle($Hwnd)
    $className = [DshInput]::WindowClass($Hwnd)
    $rectArray = [DshInput]::WindowRect($Hwnd)
    $processName = ''
    if ($processId -gt 0) {
        try { $processName = [DshInput]::ProcessImageName([uint32]$processId) } catch { $processName = '' }
    }
    return @{
        hwnd = [long]$Hwnd
        title = $title
        pid = $processId
        processName = $processName
        className = $className
        rect = @{ x = [int]$rectArray[0]; y = [int]$rectArray[1]; width = [int]$rectArray[2]; height = [int]$rectArray[3] }
        foreground = ([DshInput]::GetForegroundWindowValue() -eq $Hwnd)
        minimized = [bool][DshInput]::IsWindowIconic($Hwnd)
        self = (Test-SelfWindow $Hwnd $processId $title)
    }
}

function Get-ForegroundObject {
    $hwnd = [DshInput]::GetForegroundWindowValue()
    if ($hwnd -eq 0) {
        return @{
            hwnd = 0
            pid = 0
            title = ''
            processName = ''
            className = ''
            rect = @{ x = 0; y = 0; width = 0; height = 0 }
            isSelf = $false
            minimized = $false
        }
    }
    $processId = [int][DshInput]::WindowPid($hwnd)
    $title = [DshInput]::WindowTitle($hwnd)
    $className = [DshInput]::WindowClass($hwnd)
    $rectArray = [DshInput]::WindowRect($hwnd)
    $processName = ''
    if ($processId -gt 0) {
        try { $processName = [DshInput]::ProcessImageName([uint32]$processId) } catch { $processName = '' }
    }
    return @{
        hwnd = [long]$hwnd
        pid = $processId
        title = $title
        processName = $processName
        className = $className
        rect = @{ x = [int]$rectArray[0]; y = [int]$rectArray[1]; width = [int]$rectArray[2]; height = [int]$rectArray[3] }
        isSelf = (Test-SelfWindow $hwnd $processId $title)
        minimized = [bool][DshInput]::IsWindowIconic($hwnd)
    }
}

function Set-ForegroundRetry {
    param([long]$Hwnd)
    $res = @{ ok = $false; attempts = 0; detail = '' }
    if ($Hwnd -eq 0) { $res.detail = 'invalid hwnd'; return $res }
    if ([DshInput]::GetForegroundWindowValue() -eq $Hwnd) { $res.ok = $true; return $res }
    try {
        if ([DshInput]::IsWindowIconic($Hwnd)) {
            [void][DshInput]::ShowWindowValue($Hwnd, 9)
            Wait-Ms 50
        }
    } catch { }

    $res.attempts = 1
    try { [void][DshInput]::SetForegroundWindowValue($Hwnd) } catch { }
    Wait-Ms 100
    if ([DshInput]::GetForegroundWindowValue() -eq $Hwnd) { $res.ok = $true; return $res }

    $res.attempts = 2
    try { [void][DshInput]::ForegroundViaAttach($Hwnd) } catch { }
    Wait-Ms 100
    if ([DshInput]::GetForegroundWindowValue() -eq $Hwnd) { $res.ok = $true; return $res }

    $res.attempts = 3
    try {
        [DshInput]::SendAltTap()
        Wait-Ms 30
        [void][DshInput]::SetForegroundWindowValue($Hwnd)
    } catch { }
    Wait-Ms 100
    if ([DshInput]::GetForegroundWindowValue() -eq $Hwnd) { $res.ok = $true; return $res }

    $res.detail = 'foreground lock prevented activation'
    return $res
}

function Restore-Foreground {
    param([long]$Hwnd)
    if ($Hwnd -le 0) { return }
    try {
        if ([DshInput]::GetForegroundWindowValue() -eq $Hwnd) { return }
        [void][DshInput]::SetForegroundWindowValue($Hwnd)
        Wait-Ms 80
        if ([DshInput]::GetForegroundWindowValue() -ne $Hwnd) {
            [void][DshInput]::ForegroundViaAttach($Hwnd)
            Wait-Ms 80
        }
    } catch { }
}

# ------------------------------------------------------- selftest checks ----

function New-Check {
    param([string]$Name, [string]$Status, [string]$Detail)
    return @{ name = $Name; status = $Status; detail = (ConvertTo-AsciiMessage $Detail) }
}

function New-DpiCheck {
    try {
        $detail = 'dpiAware=' + $script:DpiAware + ' dpi=' + $script:Dpi + ' scale=' + $script:Scale
        if ($script:DpiAware -and $script:Scale -gt 0) {
            return New-Check 'dpi' 'ok' $detail
        }
        return New-Check 'dpi' 'fail' $detail
    } catch {
        return New-Check 'dpi' 'fail' ('exception: ' + $_.Exception.Message)
    }
}

function New-ScreenCheck {
    try {
        $detail = 'physical=' + $script:ScreenW + 'x' + $script:ScreenH + ' origin=' + $script:ScreenX + ',' + $script:ScreenY + ' monitors=' + $script:MonitorCount
        if ($script:ScreenW -gt 0 -and $script:ScreenH -gt 0) {
            return New-Check 'screen' 'ok' $detail
        }
        return New-Check 'screen' 'fail' $detail
    } catch {
        return New-Check 'screen' 'fail' ('exception: ' + $_.Exception.Message)
    }
}

function New-MouseMoveCheck {
    param([bool]$Skip)
    if ($Skip) { return New-Check 'mouse-move' 'skip' 'skipped by request' }
    $saved = $null
    $centerError = -1
    $restoreError = -1
    $failure = ''
    try {
        $saved = Get-CursorXY
        $centerX = $script:ScreenX + [int]($script:ScreenW / 2)
        $centerY = $script:ScreenY + [int]($script:ScreenH / 2)
        [DshInput]::MoveCursor($centerX, $centerY)
        Wait-Ms 20
        $point = Get-CursorXY
        $centerError = [Math]::Max([Math]::Abs([int]$point.x - $centerX), [Math]::Abs([int]$point.y - $centerY))
    } catch {
        $failure = $_.Exception.Message
    } finally {
        if ($null -ne $saved) {
            try {
                [DshInput]::MoveCursor([int]$saved.x, [int]$saved.y)
                Wait-Ms 20
                $point2 = Get-CursorXY
                $restoreError = [Math]::Max([Math]::Abs([int]$point2.x - [int]$saved.x), [Math]::Abs([int]$point2.y - [int]$saved.y))
            } catch {
                if ($failure -eq '') { $failure = $_.Exception.Message }
            }
        }
    }
    if ($failure -ne '') {
        return New-Check 'mouse-move' 'fail' ('exception: ' + $failure)
    }
    $detail = 'center error=' + $centerError + ' restore error=' + $restoreError
    if ($centerError -le 1 -and $restoreError -le 1) {
        return New-Check 'mouse-move' 'ok' $detail
    }
    return New-Check 'mouse-move' 'fail' $detail
}

function New-MouseClickCheck {
    param([bool]$Skip)
    if ($Skip) { return New-Check 'mouse-click' 'skip' 'skipped by request' }
    $previousFg = [DshInput]::GetForegroundWindowValue()
    $window = $null
    $status = 'fail'
    $detail = ''
    try {
        $window = New-Object -TypeName DshSelfTestWindow -ArgumentList @('click', 300, 220, $false)
        $left = $script:ScreenX + [int](($script:ScreenW - 320) / 2)
        $top = $script:ScreenY + [int](($script:ScreenH - 250) / 2)
        $window.ShowAt($left, $top)
        Wait-Ms 150
        $activated = Set-ForegroundRetry $window.HandleValue
        if (-not $activated.ok) {
            $status = 'skip'
            $detail = 'could not activate selftest window; attempts=' + $activated.attempts + '; ' + $activated.detail
        } elseif ([DshInput]::GetForegroundWindowValue() -ne $window.HandleValue) {
            $status = 'skip'
            $detail = 'selftest window lost foreground before click'
        } else {
            $point = $window.ButtonScreenCenter()
            [DshInput]::MoveCursor([int]$point[0], [int]$point[1])
            $window.PumpFor(120)
            if ([DshInput]::GetForegroundWindowValue() -ne $window.HandleValue) {
                $status = 'skip'
                $detail = 'selftest window lost foreground before click'
            } else {
                [DshInput]::SendButtonPress(0)
                $clickStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
                while ($clickStopwatch.ElapsedMilliseconds -lt 1200 -and $window.ClickCount -lt 1) {
                    $window.PumpFor(50)
                }
                if ($window.ClickCount -ge 1) {
                    $status = 'ok'
                    $detail = 'button click received, count=' + $window.ClickCount
                } else {
                    $status = 'fail'
                    $detail = 'left click not delivered to button'
                }
            }
        }
    } catch {
        $status = 'fail'
        $detail = 'exception: ' + $_.Exception.Message
    } finally {
        if ($null -ne $window) {
            try { $window.CloseWindow() } catch { }
        }
        Restore-Foreground $previousFg
    }
    return New-Check 'mouse-click' $status $detail
}

function New-KeyStateCheck {
    param([bool]$Skip)
    if ($Skip) { return New-Check 'key-state' 'skip' 'skipped by request' }
    $sentDown = $false
    try {
        [DshInput]::SendKey(0x87, $false, $false)
        $sentDown = $true
        Wait-Ms 40
        $isDown = [DshInput]::IsKeyDown(0x87)
        [DshInput]::SendKey(0x87, $false, $true)
        $sentDown = $false
        Wait-Ms 30
        $isUp = -not ([DshInput]::IsKeyDown(0x87))
        if ($isDown) {
            return New-Check 'key-state' 'ok' ('F24 down observed, release observed=' + $isUp)
        }
        return New-Check 'key-state' 'fail' 'F24 down state not observed after SendInput'
    } catch {
        return New-Check 'key-state' 'fail' ('exception: ' + $_.Exception.Message)
    } finally {
        if ($sentDown) {
            try { [DshInput]::SendKey(0x87, $false, $true) } catch { }
        }
    }
}

function New-KeyboardTypeCheck {
    param([bool]$Skip, [string]$Text)
    if ($Skip) { return New-Check 'keyboard-type' 'skip' 'skipped by request' }
    $previousFg = [DshInput]::GetForegroundWindowValue()
    $window = $null
    $status = 'fail'
    $detail = ''
    try {
        $normalized = ConvertTo-NormalizedText $Text
        $expected = $normalized
        if ($normalized.Contains("`n")) { $expected = $normalized.Replace("`n", "`r`n") }
        $multiline = $normalized.Contains("`n")
        $window = New-Object -TypeName DshSelfTestWindow -ArgumentList @('type', 420, 220, $multiline)
        $left = $script:ScreenX + [int](($script:ScreenW - 440) / 2)
        $top = $script:ScreenY + [int](($script:ScreenH - 250) / 2)
        $window.ShowAt($left, $top)
        Wait-Ms 150
        $activated = Set-ForegroundRetry $window.HandleValue
        if (-not $activated.ok) {
            $status = 'skip'
            $detail = 'could not activate selftest window; attempts=' + $activated.attempts + '; ' + $activated.detail
        } else {
            $window.FocusMainControl()
            Wait-Ms 80
            if ([DshInput]::GetForegroundWindowValue() -ne $window.HandleValue) {
                $status = 'skip'
                $detail = 'selftest window lost foreground before typing'
            } else {
                [void](Send-TextRaw $normalized 0 $false)
                $typeStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
                while ($typeStopwatch.ElapsedMilliseconds -lt 2500 -and $window.TextBoxValue.Length -lt $expected.Length) {
                    $window.PumpFor(50)
                }
                $got = [string]$window.TextBoxValue
                if ($got -ceq $expected) {
                    $window.ClearKeyChord()
                    [DshInput]::SendKey(0x11, $false, $false)
                    [DshInput]::SendKey(0x53, $false, $false)
                    [DshInput]::SendKey(0x53, $false, $true)
                    [DshInput]::SendKey(0x11, $false, $true)
                    $chordStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
                    while ($chordStopwatch.ElapsedMilliseconds -lt 1500 -and $window.LastKeyChord -eq '') {
                        $window.PumpFor(50)
                    }
                    $chord = [string]$window.LastKeyChord
                    if ($chord -match 'Control' -and $chord -match 'S') {
                        $status = 'ok'
                        $detail = 'text roundtrip ok, chars=' + $expected.Length + ', chord=' + $chord
                    } else {
                        $status = 'fail'
                        $detail = 'ctrl+s chord not observed: got [' + $chord + '] fg=' + [DshInput]::GetForegroundWindowValue() + ' handle=' + $window.HandleValue
                    }
                } else {
                    $status = 'fail'
                    $codeText = ''
                    $codeLimit = [Math]::Min($got.Length, 40)
                    for ($ci = 0; $ci -lt $codeLimit; $ci++) {
                        $codeText = $codeText + ('{0:X4}' -f [int][char]$got[$ci]) + ' '
                    }
                    $detail = 'text mismatch: got length=' + $got.Length + ' expected length=' + $expected.Length + ' gotCodes=' + $codeText.Trim() + ' fg=' + [DshInput]::GetForegroundWindowValue() + ' handle=' + $window.HandleValue
                }
            }
        }
    } catch {
        $status = 'fail'
        $detail = 'exception: ' + $_.Exception.Message
    } finally {
        try {
            [DshInput]::SendKey(0x11, $false, $true)
        } catch { }
        if ($null -ne $window) {
            try { $window.CloseWindow() } catch { }
        }
        Restore-Foreground $previousFg
    }
    return New-Check 'keyboard-type' $status $detail
}

function New-WheelCheck {
    param([bool]$Skip)
    if ($Skip) { return New-Check 'wheel' 'skip' 'skipped by request' }
    $previousFg = [DshInput]::GetForegroundWindowValue()
    $window = $null
    $status = 'fail'
    $detail = ''
    try {
        $window = New-Object -TypeName DshSelfTestWindow -ArgumentList @('wheel', 320, 260, $false)
        $left = $script:ScreenX + [int](($script:ScreenW - 340) / 2)
        $top = $script:ScreenY + [int](($script:ScreenH - 290) / 2)
        $window.ShowAt($left, $top)
        Wait-Ms 150
        $activated = Set-ForegroundRetry $window.HandleValue
        if (-not $activated.ok) {
            $status = 'skip'
            $detail = 'could not activate selftest window; attempts=' + $activated.attempts + '; ' + $activated.detail
        } else {
            $point = $window.PanelScreenCenter()
            [DshInput]::MoveCursor([int]$point[0], [int]$point[1])
            Wait-Ms 40
            $window.FocusMainControl()
            $window.PumpFor(120)
            $before = [int]$window.PanelScrollValue
            [DshInput]::SendWheel(-3, $false)
            $wheelStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            while ($wheelStopwatch.ElapsedMilliseconds -lt 2000 -and $window.PanelScrollValue -le 0) {
                $window.PumpFor(50)
            }
            $after = [int]$window.PanelScrollValue
            $detail = 'scroll before=' + $before + ' after=' + $after
            if ($after -gt 0) {
                $status = 'ok'
            } else {
                $status = 'fail'
                $detail = 'wheel did not scroll panel: ' + $detail
            }
        }
    } catch {
        $status = 'fail'
        $detail = 'exception: ' + $_.Exception.Message
    } finally {
        if ($null -ne $window) {
            try { $window.CloseWindow() } catch { }
        }
        Restore-Foreground $previousFg
    }
    return New-Check 'wheel' $status $detail
}

# ------------------------------------------------------------- op logic ----

function Invoke-PingOp {
    return @{ pong = $true; uptimeMs = [long]$script:Stopwatch.ElapsedMilliseconds }
}

function Invoke-StatusOp {
    $pressedKeys = New-Object System.Collections.ArrayList
    foreach ($key in $script:PressedKeys) { [void]$pressedKeys.Add([int]$key) }
    $pressedButtons = New-Object System.Collections.ArrayList
    foreach ($button in $script:PressedButtons) { [void]$pressedButtons.Add([string]$button) }
    return @{
        helperVersion = $script:HelperVersion
        protocol = $script:ProtocolVersion
        pid = [int]$PID
        psVersion = $PSVersionTable.PSVersion.ToString()
        elevated = [bool]$script:Elevated
        dpiAware = [bool]$script:DpiAware
        monitorCount = [int]$script:MonitorCount
        screen = New-ScreenInfo
        cursor = Get-CursorXY
        foreground = Get-ForegroundObject
        paused = (Test-Paused)
        pauseFile = $script:PauseFile
        pressedKeys = $pressedKeys
        pressedButtons = $pressedButtons
        uptimeMs = [long]$script:Stopwatch.ElapsedMilliseconds
        os = @{ caption = $script:OsCaption; build = $script:OsBuild }
    }
}

function Invoke-MoveOp {
    param($A)
    $hasX = Test-HasArg $A 'x'
    $hasY = Test-HasArg $A 'y'
    $hasDx = Test-HasArg $A 'dx'
    $hasDy = Test-HasArg $A 'dy'
    if ($hasX -ne $hasY) { Throw-Helper 'E_BAD_ARGS' 'x and y must be provided together' }
    if ($hasDx -ne $hasDy) { Throw-Helper 'E_BAD_ARGS' 'dx and dy must be provided together' }
    if ($hasX -and $hasDx) { Throw-Helper 'E_BAD_ARGS' 'use either x/y or dx/dy, not both' }
    if ((-not $hasX) -and (-not $hasDx)) { Throw-Helper 'E_BAD_ARGS' 'missing x/y or dx/dy' }

    $durationMs = Get-IntArg $A 'durationMs' $false 0 0 5000
    $defaultSteps = 1
    if ($durationMs -gt 0) { $defaultSteps = 30 }
    $steps = Get-IntArg $A 'steps' $false $defaultSteps 1 500

    $from = Get-CursorXY
    if ($hasX) {
        $targetX = [long](ConvertTo-IntValue (Get-ArgValue $A 'x') 'x')
        $targetY = [long](ConvertTo-IntValue (Get-ArgValue $A 'y') 'y')
    } else {
        $deltaX = [long](ConvertTo-IntValue (Get-ArgValue $A 'dx') 'dx')
        $deltaY = [long](ConvertTo-IntValue (Get-ArgValue $A 'dy') 'dy')
        $targetX = [long]$from.x + $deltaX
        $targetY = [long]$from.y + $deltaY
    }
    Assert-InBounds $targetX $targetY

    for ($i = 1; $i -le $steps; $i++) {
        if ($i -ge $steps) {
            $nextX = $targetX
            $nextY = $targetY
        } else {
            $nextX = [long][Math]::Round([double]$from.x + ((([double]$targetX - [double]$from.x) * $i) / $steps))
            $nextY = [long][Math]::Round([double]$from.y + ((([double]$targetY - [double]$from.y) * $i) / $steps))
        }
        Set-CursorXY $nextX $nextY
        if ($i -lt $steps) { Wait-Ms $script:StepDelayMs }
    }
    $actual = Get-CursorXY
    return @{
        from = @{ x = [int]$from.x; y = [int]$from.y }
        target = @{ x = [int]$targetX; y = [int]$targetY }
        actual = @{ x = [int]$actual.x; y = [int]$actual.y }
        steps = [int]$steps
    }
}

function Invoke-ClickOp {
    param($A)
    $button = Get-ButtonArg $A
    $count = Get-IntArg $A 'count' $false 1 1 3
    $intervalMs = Get-IntArg $A 'intervalMs' $false 40 0 500
    $hasX = Test-HasArg $A 'x'
    $hasY = Test-HasArg $A 'y'
    if ($hasX -ne $hasY) { Throw-Helper 'E_BAD_ARGS' 'x and y must be provided together' }
    $position = Get-CursorXY
    if ($hasX) {
        $targetX = [long](ConvertTo-IntValue (Get-ArgValue $A 'x') 'x')
        $targetY = [long](ConvertTo-IntValue (Get-ArgValue $A 'y') 'y')
        Assert-InBounds $targetX $targetY
        Set-CursorXY $targetX $targetY
        Wait-Ms 10
        $position = @{ x = [int]$targetX; y = [int]$targetY }
    }
    for ($i = 0; $i -lt $count; $i++) {
        [DshInput]::SendButtonPress($button.index)
        if ($i -lt ($count - 1)) { Wait-Ms $intervalMs }
    }
    $actual = Get-CursorXY
    return @{
        button = $button.name
        count = [int]$count
        position = @{ x = [int]$position.x; y = [int]$position.y }
        actual = @{ x = [int]$actual.x; y = [int]$actual.y }
    }
}

function Invoke-DragOp {
    param($A)
    $fromX = [long](Get-RequiredIntArg $A 'fromX')
    $fromY = [long](Get-RequiredIntArg $A 'fromY')
    $toX = [long](Get-RequiredIntArg $A 'toX')
    $toY = [long](Get-RequiredIntArg $A 'toY')
    $button = Get-ButtonArg $A
    $durationMs = Get-IntArg $A 'durationMs' $false 300 0 5000
    $steps = Get-IntArg $A 'steps' $false 40 1 500
    Assert-InBounds $fromX $fromY
    Assert-InBounds $toX $toY

    $buttonIsDown = $false
    $failure = $null
    try {
        Set-CursorXY $fromX $fromY
        Wait-Ms 10
        [DshInput]::SendMouseButton($button.index, $true)
        $buttonIsDown = $true
        Add-PressedButton $button.name
        for ($i = 1; $i -le $steps; $i++) {
            if ($i -ge $steps) {
                $nextX = $toX
                $nextY = $toY
            } else {
                $nextX = [long][Math]::Round([double]$fromX + ((([double]$toX - [double]$fromX) * $i) / $steps))
                $nextY = [long][Math]::Round([double]$fromY + ((([double]$toY - [double]$fromY) * $i) / $steps))
            }
            Set-CursorXY $nextX $nextY
            if ($i -lt $steps) { Wait-Ms $script:StepDelayMs }
        }
        Wait-Ms 10
    } catch {
        $failure = $_.Exception
    } finally {
        if ($buttonIsDown) {
            try {
                [DshInput]::SendMouseButton($button.index, $false)
            } catch {
                if ($null -eq $failure) { $failure = $_.Exception }
            }
            Remove-PressedButton $button.name
        }
    }
    if ($null -ne $failure) { throw $failure }
    $actual = Get-CursorXY
    return @{
        from = @{ x = [int]$fromX; y = [int]$fromY }
        to = @{ x = [int]$toX; y = [int]$toY }
        actual = @{ x = [int]$actual.x; y = [int]$actual.y }
        steps = [int]$steps
    }
}

function Invoke-WheelOp {
    param($A)
    $delta = Get-IntArg $A 'delta' $true 0 -10 10
    $horizontal = Get-BoolArg $A 'horizontal' $false
    $hasX = Test-HasArg $A 'x'
    $hasY = Test-HasArg $A 'y'
    if ($hasX -ne $hasY) { Throw-Helper 'E_BAD_ARGS' 'x and y must be provided together' }
    if ($hasX) {
        $targetX = [long](ConvertTo-IntValue (Get-ArgValue $A 'x') 'x')
        $targetY = [long](ConvertTo-IntValue (Get-ArgValue $A 'y') 'y')
        Assert-InBounds $targetX $targetY
        Set-CursorXY $targetX $targetY
        Wait-Ms 10
    }
    [DshInput]::SendWheel([int]$delta, [bool]$horizontal)
    $position = Get-CursorXY
    return @{
        delta = [int]$delta
        horizontal = [bool]$horizontal
        position = @{ x = [int]$position.x; y = [int]$position.y }
    }
}

function Invoke-KeyOp {
    param($A)
    $rawKeys = Get-ArgValue $A 'keys'
    if ($null -eq $rawKeys) { Throw-Helper 'E_BAD_ARGS' 'missing keys' }
    $keyItems = @($rawKeys)
    if ($keyItems.Count -lt 1 -or $keyItems.Count -gt 6) {
        Throw-Helper 'E_BAD_ARGS' 'keys must contain 1 to 6 items'
    }
    $action = Get-StringArg $A 'action' $false 'press'
    if ($action -ne 'press' -and $action -ne 'down' -and $action -ne 'up') {
        Throw-Helper 'E_BAD_ARGS' ('invalid action: ' + $action)
    }
    $repeat = Get-IntArg $A 'repeat' $false 1 1 20
    $holdMs = Get-IntArg $A 'holdMs' $false 0 0 2000
    $delayMs = Get-IntArg $A 'delayMs' $false 0 0 1000

    $vks = New-Object System.Collections.ArrayList
    $extended = New-Object System.Collections.ArrayList
    foreach ($item in $keyItems) {
        if ($null -eq $item) { Throw-Helper 'E_BAD_ARGS' 'invalid key item' }
        if (-not (Test-HasArg $item 'vk')) { Throw-Helper 'E_BAD_ARGS' 'key item missing vk' }
        $vk = ConvertTo-IntValue (Get-ArgValue $item 'vk') 'vk'
        if ($vk -lt 1 -or $vk -gt 255) { Throw-Helper 'E_BAD_ARGS' 'vk out of range 1..255' }
        [void]$vks.Add([int]$vk)
        [void]$extended.Add((Get-BoolArg $item 'extended' $false))
    }

    if ($action -ne 'up') {
        if ($script:GuardSelf) { Assert-NotSelfFocus }
    }

    if ($action -eq 'press') {
        for ($round = 0; $round -lt $repeat; $round++) {
            try {
                Send-KeySequence $vks $extended $false
                foreach ($vk in $vks) { Add-PressedKey ([int]$vk) }
                Wait-Ms $holdMs
                Send-KeySequence $vks $extended $true
                foreach ($vk in $vks) { Remove-PressedKey ([int]$vk) }
                Wait-Ms $delayMs
            } catch {
                try { Send-KeySequence $vks $extended $true } catch { }
                foreach ($vk in $vks) { Remove-PressedKey ([int]$vk) }
                throw $_.Exception
            }
        }
    } elseif ($action -eq 'down') {
        Send-KeySequence $vks $extended $false
        foreach ($vk in $vks) { Add-PressedKey ([int]$vk) }
    } else {
        Send-KeySequence $vks $extended $true
        foreach ($vk in $vks) { Remove-PressedKey ([int]$vk) }
    }

    $resultKeys = New-Object System.Collections.ArrayList
    foreach ($vk in $vks) { [void]$resultKeys.Add([int]$vk) }
    return @{
        keys = $resultKeys
        action = $action
        repeat = [int]$repeat
    }
}

function Invoke-TypeOp {
    param($A)
    $text = Get-StringArg $A 'text' $true ''
    $intervalMs = Get-IntArg $A 'intervalMs' $false 0 0 200
    $submit = Get-BoolArg $A 'submit' $false
    if ($script:GuardSelf) { Assert-NotSelfFocus }
    return (Send-TextRaw $text $intervalMs $submit)
}

function Invoke-WindowsOp {
    param($A)
    $filter = Get-StringArg $A 'filter' $false ''
    $limit = Get-IntArg $A 'limit' $false 50 1 100
    $includeMinimized = Get-BoolArg $A 'includeMinimized' $true
    $foregroundHwnd = [DshInput]::GetForegroundWindowValue()
    $rawHandles = @([DshInput]::EnumVisibleWindows())

    $entries = New-Object System.Collections.ArrayList
    foreach ($handle in $rawHandles) {
        $hwnd = [long]$handle
        if (-not $includeMinimized) {
            if ([DshInput]::IsWindowIconic($hwnd)) { continue }
        }
        $title = [DshInput]::WindowTitle($hwnd)
        if ([string]::IsNullOrEmpty($title)) { continue }
        if ($filter.Length -gt 0) {
            if ($title.IndexOf($filter, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        }
        $processId = [int][DshInput]::WindowPid($hwnd)
        [void]$entries.Add([pscustomobject]@{
            hwnd = $hwnd
            title = $title
            pid = $processId
            foreground = ($hwnd -eq $foregroundHwnd)
        })
    }
    $total = $entries.Count
    $sorted = @($entries | Sort-Object -Property @(
        @{ Expression = { if ($_.foreground) { 0 } else { 1 } } },
        @{ Expression = { $_.pid } },
        @{ Expression = { $_.title } }
    ))
    $selected = @($sorted | Select-Object -First $limit)

    $windows = New-Object System.Collections.ArrayList
    foreach ($entry in $selected) {
        $rectArray = [DshInput]::WindowRect($entry.hwnd)
        $processName = ''
        if ($entry.pid -gt 0) {
            try { $processName = [DshInput]::ProcessImageName([uint32]$entry.pid) } catch { $processName = '' }
        }
        $className = [DshInput]::WindowClass($entry.hwnd)
        [void]$windows.Add(@{
            hwnd = [long]$entry.hwnd
            title = [string]$entry.title
            pid = [int]$entry.pid
            processName = $processName
            className = $className
            rect = @{ x = [int]$rectArray[0]; y = [int]$rectArray[1]; width = [int]$rectArray[2]; height = [int]$rectArray[3] }
            foreground = [bool]$entry.foreground
            minimized = [bool][DshInput]::IsWindowIconic($entry.hwnd)
            self = (Test-SelfWindow $entry.hwnd $entry.pid $entry.title)
        })
    }
    return @{ total = [int]$total; windows = $windows }
}

function Invoke-FocusOp {
    param($A)
    $hasHwnd = Test-HasArg $A 'hwnd'
    $hasTitle = Test-HasArg $A 'title'
    $hasPid = Test-HasArg $A 'pid'
    if (-not ($hasHwnd -or $hasTitle -or $hasPid)) {
        Throw-Helper 'E_BAD_ARGS' 'missing hwnd, title or pid'
    }
    $exact = Get-BoolArg $A 'exact' $false
    $target = 0
    $rawHandles = @([DshInput]::EnumVisibleWindows())

    if ($hasHwnd) {
        $hwndValue = [long](ConvertTo-IntValue (Get-ArgValue $A 'hwnd') 'hwnd')
        if ($hwndValue -le 0) { Throw-Helper 'E_BAD_ARGS' 'invalid hwnd' }
        if ([DshInput]::IsWindowValue($hwndValue)) {
            $target = $hwndValue
        } else {
            Throw-Helper 'E_WINDOW_NOT_FOUND' ('window not found: ' + $hwndValue)
        }
    } elseif ($hasTitle) {
        $needle = Get-StringArg $A 'title' $true ''
        foreach ($handle in $rawHandles) {
            $hwnd = [long]$handle
            $title = [DshInput]::WindowTitle($hwnd)
            if ([string]::IsNullOrEmpty($title)) { continue }
            if ($exact) {
                if ($title -ceq $needle) { $target = $hwnd; break }
            } else {
                if ($title.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $target = $hwnd; break }
            }
        }
        if ($target -eq 0) { Throw-Helper 'E_WINDOW_NOT_FOUND' 'window not found' }
    } else {
        $wantedPid = Get-RequiredIntArg $A 'pid'
        foreach ($handle in $rawHandles) {
            $hwnd = [long]$handle
            $processId = [int][DshInput]::WindowPid($hwnd)
            if ($processId -eq $wantedPid) { $target = $hwnd; break }
        }
        if ($target -eq 0) { Throw-Helper 'E_WINDOW_NOT_FOUND' 'window not found' }
    }

    $previous = Get-ForegroundObject
    try {
        if ([DshInput]::IsWindowIconic($target)) {
            [void][DshInput]::ShowWindowValue($target, 9)
            Wait-Ms 50
        }
    } catch { }
    $activated = Set-ForegroundRetry $target
    $currentHwnd = [DshInput]::GetForegroundWindowValue()
    $current = Get-WindowObject $currentHwnd
    $result = @{
        ok = [bool]$activated.ok
        target = (Get-WindowObject $target)
        previous = $previous
        current = $current
        attempts = [int]$activated.attempts
    }
    if (-not $activated.ok) {
        $hintText = $activated.detail
        if ([string]::IsNullOrEmpty($hintText)) { $hintText = 'SetForegroundWindow was rejected by the foreground lock' }
        $result['hint'] = $hintText
    }
    return $result
}

function Invoke-ScreenshotOp {
    param($A)
    $path = Get-StringArg $A 'path' $true ''
    if ([string]::IsNullOrEmpty($path)) { Throw-Helper 'E_BAD_ARGS' 'path must not be empty' }
    try {
        if (-not [IO.Path]::IsPathRooted($path)) { Throw-Helper 'E_BAD_ARGS' 'path must be absolute' }
    } catch [System.Management.Automation.RuntimeException] {
        throw
    } catch {
        Throw-Helper 'E_BAD_ARGS' 'invalid path'
    }

    $region = Get-ArgValue $A 'region'
    if ($null -eq $region) {
        $regionX = [int]$script:ScreenX
        $regionY = [int]$script:ScreenY
        $regionW = [int]$script:ScreenW
        $regionH = [int]$script:ScreenH
    } else {
        $regionX = ConvertTo-IntValue (Get-ArgValue $region 'x') 'region.x'
        $regionY = ConvertTo-IntValue (Get-ArgValue $region 'y') 'region.y'
        $regionW = ConvertTo-IntValue (Get-ArgValue $region 'width') 'region.width'
        $regionH = ConvertTo-IntValue (Get-ArgValue $region 'height') 'region.height'
        if ($regionW -le 0 -or $regionH -le 0) { Throw-Helper 'E_BAD_ARGS' 'region width and height must be positive' }
    }
    $screenLeft = [long]$script:ScreenX
    $screenTop = [long]$script:ScreenY
    $screenRight = $screenLeft + [long]$script:ScreenW
    $screenBottom = $screenTop + [long]$script:ScreenH
    if ($regionX -lt $screenLeft -or $regionY -lt $screenTop) { Throw-Helper 'E_BOUNDS' 'region outside virtual screen' }
    if ((([long]$regionX) + ([long]$regionW)) -gt $screenRight) { Throw-Helper 'E_BOUNDS' 'region outside virtual screen' }
    if ((([long]$regionY) + ([long]$regionH)) -gt $screenBottom) { Throw-Helper 'E_BOUNDS' 'region outside virtual screen' }

    $bytes = 0
    try {
        $bytes = [long][DshInput]::Screenshot($path, [int]$regionX, [int]$regionY, [int]$regionW, [int]$regionH)
    } catch {
        Throw-Helper 'E_SCREENSHOT_FAILED' ('screenshot failed: ' + $_.Exception.Message)
    }
    return @{
        path = $path
        width = [int]$regionW
        height = [int]$regionH
        bytes = [long]$bytes
        region = @{ x = [int]$regionX; y = [int]$regionY; width = [int]$regionW; height = [int]$regionH }
    }
}

function Invoke-SelftestOp {
    param($A)
    $skipMouse = Get-BoolArg $A 'skipMouse' $false
    $skipKeyboard = Get-BoolArg $A 'skipKeyboard' $false
    $text = Get-StringArg $A 'text' $false 'dsh input self-test 123'
    $savedForeground = [DshInput]::GetForegroundWindowValue()
    $savedCursor = $null
    try { $savedCursor = Get-CursorXY } catch { }

    $checks = New-Object System.Collections.ArrayList
    try {
        [void]$checks.Add((New-DpiCheck))
        [void]$checks.Add((New-ScreenCheck))
        [void]$checks.Add((New-MouseMoveCheck $skipMouse))
        [void]$checks.Add((New-MouseClickCheck $skipMouse))
        [void]$checks.Add((New-KeyStateCheck $skipKeyboard))
        [void]$checks.Add((New-KeyboardTypeCheck $skipKeyboard $text))
        [void]$checks.Add((New-WheelCheck $skipMouse))
    } finally {
        if ($null -ne $savedCursor) {
            try { [DshInput]::MoveCursor([int]$savedCursor.x, [int]$savedCursor.y) } catch { }
        }
        Restore-Foreground $savedForeground
    }
    $allOk = $true
    foreach ($check in $checks) {
        if ($check.status -eq 'fail') { $allOk = $false }
    }
    return @{ ok = [bool]$allOk; checks = $checks }
}

function Invoke-CommandOp {
    param([string]$Op, $A)
    $pauseExempt = @('status', 'windows', 'screenshot', 'ping', 'quit')
    if ($pauseExempt -notcontains $Op) {
        if (Test-Paused) { Throw-Helper 'E_PAUSED' 'helper is paused (pause file exists)' }
    }
    switch ($Op) {
        'ping' { return (Invoke-PingOp) }
        'status' { return (Invoke-StatusOp) }
        'move' { return (Invoke-MoveOp $A) }
        'click' { return (Invoke-ClickOp $A) }
        'drag' { return (Invoke-DragOp $A) }
        'wheel' { return (Invoke-WheelOp $A) }
        'key' { return (Invoke-KeyOp $A) }
        'type' { return (Invoke-TypeOp $A) }
        'windows' { return (Invoke-WindowsOp $A) }
        'focus' { return (Invoke-FocusOp $A) }
        'screenshot' { return (Invoke-ScreenshotOp $A) }
        'selftest' { return (Invoke-SelftestOp $A) }
        'quit' {
            Release-All
            return @{ ok = $true }
        }
        default { Throw-Helper 'E_PROTOCOL' ('unknown op: ' + $Op) }
    }
}

# ------------------------------------------------------------ C# bridge ----

$script:CsSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class DshInput
{
    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;

    public const int SW_SHOW = 5;
    public const int SW_RESTORE = 9;

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;
    public const int SM_CMONITORS = 80;
    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;

    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public int type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForSystem();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint flags, StringBuilder exeName, ref uint size);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKeyW(uint code, uint mapType);

    [DllImport("user32.dll")]
    public static extern uint GetDoubleClickTime();

    private static IntPtr HandleOf(long value)
    {
        return new IntPtr(value);
    }

    public static int InputSize()
    {
        return Marshal.SizeOf(typeof(INPUT));
    }

    public static long SetDpiAware()
    {
        try
        {
            return SetThreadDpiAwarenessContext(new IntPtr(-4)).ToInt64();
        }
        catch (EntryPointNotFoundException)
        {
            return 0;
        }
        catch (DllNotFoundException)
        {
            return 0;
        }
    }

    public static uint SystemDpi()
    {
        try
        {
            return GetDpiForSystem();
        }
        catch
        {
            return 96;
        }
    }

    public static int[] VirtualScreenRect()
    {
        int x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        int h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        return new int[] { x, y, w, h };
    }

    public static int MonitorCount()
    {
        return GetSystemMetrics(SM_CMONITORS);
    }

    public static int[] Cursor()
    {
        POINT point;
        if (!GetCursorPos(out point))
        {
            throw new InvalidOperationException("GetCursorPos failed, error=" + Marshal.GetLastWin32Error());
        }
        return new int[] { point.x, point.y };
    }

    public static void MoveCursor(int x, int y)
    {
        if (!SetCursorPos(x, y))
        {
            throw new InvalidOperationException("SetCursorPos failed, error=" + Marshal.GetLastWin32Error());
        }
    }

    public static INPUT MakeKey(int vk, bool extended, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.wScan = (ushort)MapVirtualKeyW((uint)vk, 0);
        input.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0u) | (extended ? KEYEVENTF_EXTENDEDKEY : 0u);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    public static INPUT MakeUnicode(int codeUnit, bool up)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = 0;
        input.u.ki.wScan = (ushort)codeUnit;
        input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u);
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    public static INPUT MakeMouse(int dx, int dy, int data, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = data;
        input.u.mi.dwFlags = flags;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    public static INPUT MakeButton(int button, bool down)
    {
        uint flag = MOUSEEVENTF_LEFTDOWN;
        if (button == 1)
        {
            flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        }
        else if (button == 2)
        {
            flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        }
        else
        {
            flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        }
        return MakeMouse(0, 0, 0, flag);
    }

    public static int SendInputs(INPUT[] inputs)
    {
        if (inputs == null || inputs.Length == 0)
        {
            return 0;
        }
        int size = Marshal.SizeOf(typeof(INPUT));
        uint sent = SendInput((uint)inputs.Length, inputs, size);
        if (sent != (uint)inputs.Length)
        {
            int error = Marshal.GetLastWin32Error();
            throw new InvalidOperationException("SendInput failed: sent=" + sent + "/" + inputs.Length + ", error=" + error);
        }
        return (int)sent;
    }

    public static void SendKey(int vk, bool extended, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0] = MakeKey(vk, extended, up);
        SendInputs(inputs);
    }

    public static void SendUnicode(int codeUnit, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0] = MakeUnicode(codeUnit, up);
        SendInputs(inputs);
    }

    public static void SendMouseButton(int button, bool down)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0] = MakeButton(button, down);
        SendInputs(inputs);
    }

    public static void SendButtonPress(int button)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0] = MakeButton(button, true);
        inputs[1] = MakeButton(button, false);
        SendInputs(inputs);
    }

    public static void SendWheel(int delta, bool horizontal)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0] = MakeMouse(0, 0, delta * 120, horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL);
        SendInputs(inputs);
    }

    public static void SendKeyList(int[] vks, int[] extended, int[] upFlags)
    {
        if (vks == null || vks.Length == 0)
        {
            throw new InvalidOperationException("empty key list");
        }
        int count = vks.Length;
        INPUT[] inputs = new INPUT[count];
        for (int i = 0; i < count; i++)
        {
            bool isExtended = (extended != null && i < extended.Length && extended[i] != 0);
            bool isUp = (upFlags != null && i < upFlags.Length && upFlags[i] != 0);
            inputs[i] = MakeKey(vks[i], isExtended, isUp);
        }
        SendInputs(inputs);
    }

    private static void FlushBatch(List<INPUT> batch)
    {
        if (batch.Count == 0)
        {
            return;
        }
        SendInputs(batch.ToArray());
        batch.Clear();
    }

    public static int SendTextUnicode(string text, int intervalMs)
    {
        if (String.IsNullOrEmpty(text))
        {
            return 0;
        }
        int typed = 0;
        List<INPUT> batch = new List<INPUT>();
        foreach (char ch in text)
        {
            List<INPUT> one = new List<INPUT>();
            if (ch == '\n')
            {
                one.Add(MakeKey(0x0D, false, false));
                one.Add(MakeKey(0x0D, false, true));
            }
            else if (ch == '\t')
            {
                one.Add(MakeKey(0x09, false, false));
                one.Add(MakeKey(0x09, false, true));
            }
            else
            {
                one.Add(MakeUnicode(ch, false));
                one.Add(MakeUnicode(ch, true));
                typed++;
            }
            if (intervalMs <= 0)
            {
                batch.AddRange(one);
                if (batch.Count >= 128)
                {
                    FlushBatch(batch);
                }
            }
            else
            {
                FlushBatch(one);
                Thread.Sleep(intervalMs);
            }
        }
        FlushBatch(batch);
        return typed;
    }

    public static long GetForegroundWindowValue()
    {
        return GetForegroundWindow().ToInt64();
    }

    public static bool IsWindowValue(long hwnd)
    {
        return IsWindow(HandleOf(hwnd));
    }

    public static bool IsWindowVisibleValue(long hwnd)
    {
        return IsWindowVisible(HandleOf(hwnd));
    }

    public static bool IsWindowIconic(long hwnd)
    {
        return IsIconic(HandleOf(hwnd));
    }

    public static bool ShowWindowValue(long hwnd, int cmd)
    {
        return ShowWindow(HandleOf(hwnd), cmd);
    }

    public static bool SetForegroundWindowValue(long hwnd)
    {
        return SetForegroundWindow(HandleOf(hwnd));
    }

    public static string WindowTitle(long hwnd)
    {
        IntPtr handle = HandleOf(hwnd);
        int length = GetWindowTextLengthW(handle);
        StringBuilder buffer = new StringBuilder(length + 2);
        GetWindowTextW(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static string WindowClass(long hwnd)
    {
        StringBuilder buffer = new StringBuilder(512);
        GetClassNameW(HandleOf(hwnd), buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static int[] WindowRect(long hwnd)
    {
        RECT rect;
        if (!GetWindowRect(HandleOf(hwnd), out rect))
        {
            return new int[] { 0, 0, 0, 0 };
        }
        return new int[] { rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top };
    }

    public static int WindowPid(long hwnd)
    {
        uint processId;
        GetWindowThreadProcessId(HandleOf(hwnd), out processId);
        return (int)processId;
    }

    public static string ProcessImageName(uint processId)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == IntPtr.Zero)
        {
            return "";
        }
        try
        {
            StringBuilder buffer = new StringBuilder(1024);
            uint size = (uint)buffer.Capacity;
            if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size))
            {
                return "";
            }
            string full = buffer.ToString();
            int index = full.LastIndexOfAny(new char[] { '\\', '/' });
            if (index >= 0 && index < full.Length - 1)
            {
                return full.Substring(index + 1);
            }
            return full;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static long[] EnumVisibleWindows()
    {
        List<long> handles = new List<long>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd))
            {
                return true;
            }
            if (GetWindowTextLengthW(hWnd) <= 0)
            {
                return true;
            }
            handles.Add(hWnd.ToInt64());
            return true;
        }, IntPtr.Zero);
        return handles.ToArray();
    }

    public static bool ForegroundViaAttach(long hwnd)
    {
        IntPtr target = HandleOf(hwnd);
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != myThread)
        {
            attached = AttachThreadInput(myThread, foregroundThread, true);
        }
        try
        {
            bool ok = SetForegroundWindow(target);
            if (!ok)
            {
                BringWindowToTop(target);
            }
            return ok;
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(myThread, foregroundThread, false);
            }
        }
    }

    public static void SendAltTap()
    {
        SendKey(0x12, false, false);
        SendKey(0x12, false, true);
    }

    public static bool IsKeyDown(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    public static uint DoubleClickTime()
    {
        return GetDoubleClickTime();
    }

    public static long Screenshot(string path, int x, int y, int width, int height)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
        Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        try
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            bitmap.Save(path, ImageFormat.Png);
        }
        finally
        {
            bitmap.Dispose();
        }
        return new FileInfo(path).Length;
    }
}

public class FocusablePanel : Panel
{
    public FocusablePanel()
    {
        SetStyle(ControlStyles.Selectable, true);
        TabStop = true;
    }
}

public class DshSelfTestWindow
{
    public Form Window;
    public Button Btn;
    public TextBox Edit;
    public FocusablePanel ScrollPanel;
    public int ClickCount;
    public string LastKeyChord = "";

    public DshSelfTestWindow(string kind, int width, int height, bool multiline)
    {
        ClickCount = 0;
        LastKeyChord = "";
        Window = new Form();
        Window.KeyPreview = true;
        Window.KeyDown += new KeyEventHandler(OnWindowKeyDown);
        Window.FormBorderStyle = FormBorderStyle.FixedToolWindow;
        Window.ShowInTaskbar = false;
        Window.StartPosition = FormStartPosition.Manual;
        Window.TopMost = true;
        Window.ClientSize = new Size(width, height);
        Window.Text = "dsh-input selftest";
        if (kind == "click")
        {
            Btn = new Button();
            Btn.Text = "click";
            Btn.SetBounds(90, 80, 120, 40);
            Btn.Click += new EventHandler(OnButtonClick);
            Window.Controls.Add(Btn);
        }
        else if (kind == "type")
        {
            Edit = new TextBox();
            if (multiline)
            {
                Edit.Multiline = true;
                Edit.AcceptsReturn = true;
                Edit.ScrollBars = ScrollBars.Vertical;
                Edit.SetBounds(20, 30, width - 40, height - 70);
            }
            else
            {
                Edit.SetBounds(20, 30, width - 40, 24);
            }
            Window.Controls.Add(Edit);
            Window.ActiveControl = Edit;
        }
        else
        {
            ScrollPanel = new FocusablePanel();
            ScrollPanel.SetBounds(20, 20, width - 40, height - 40);
            ScrollPanel.AutoScroll = true;
            Label child = new Label();
            child.Text = "scrollable content";
            child.AutoSize = false;
            child.SetBounds(0, 0, ScrollPanel.Width - 30, height + 1200);
            child.BackColor = Color.LightGray;
            ScrollPanel.Controls.Add(child);
            Window.Controls.Add(ScrollPanel);
            Window.ActiveControl = ScrollPanel;
        }
    }

    private void OnButtonClick(object sender, EventArgs e)
    {
        ClickCount++;
    }

    public long HandleValue
    {
        get { return Window.Handle.ToInt64(); }
    }

    public void ShowAt(int x, int y)
    {
        Window.Location = new Point(x, y);
        Window.Show();
        Window.BringToFront();
        Window.Activate();
        Application.DoEvents();
    }

    public void Pump()
    {
        Application.DoEvents();
    }

    public void FocusMainControl()
    {
        if (Edit != null)
        {
            Edit.Focus();
        }
        else if (ScrollPanel != null)
        {
            ScrollPanel.Focus();
        }
        Application.DoEvents();
    }

    public int[] ButtonScreenCenter()
    {
        Point point = Btn.PointToScreen(new Point(Btn.Width / 2, Btn.Height / 2));
        return new int[] { point.X, point.Y };
    }

    public int[] PanelScreenCenter()
    {
        Point point = ScrollPanel.PointToScreen(new Point(ScrollPanel.Width / 2, ScrollPanel.Height / 2));
        return new int[] { point.X, point.Y };
    }

    public int PanelScrollValue
    {
        get
        {
            if (ScrollPanel == null)
            {
                return -1;
            }
            return ScrollPanel.VerticalScroll.Value;
        }
    }

    public string TextBoxValue
    {
        get
        {
            if (Edit == null)
            {
                return "";
            }
            return Edit.Text;
        }
    }

    public int TextBoxSelectionLength
    {
        get
        {
            if (Edit == null)
            {
                return -1;
            }
            return Edit.SelectionLength;
        }
    }

    private void OnWindowKeyDown(object sender, KeyEventArgs e)
    {
        string chord = "";
        if (e.Control) { chord += "Control+"; }
        if (e.Alt) { chord += "Alt+"; }
        if (e.Shift) { chord += "Shift+"; }
        chord += e.KeyCode.ToString();
        LastKeyChord = chord;
    }

    public void ClearKeyChord()
    {
        LastKeyChord = "";
    }

    public void PumpFor(int milliseconds)
    {
        System.Diagnostics.Stopwatch stopwatch = System.Diagnostics.Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < milliseconds)
        {
            Application.DoEvents();
            System.Threading.Thread.Sleep(10);
        }
        Application.DoEvents();
    }

    public void CloseWindow()
    {
        try
        {
            if (Window != null)
            {
                Window.Hide();
                Window.Close();
                Application.DoEvents();
                Window.Dispose();
            }
        }
        catch
        {
        }
    }
}
'@

# -------------------------------------------------------------- startup ----

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition $script:CsSource -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll'
} catch {
    $startupMessage = 'Add-Type failed: ' + $_.Exception.Message
    try { [Console]::Error.WriteLine((ConvertTo-AsciiMessage $startupMessage)) } catch { }
    try { Send-ErrorResponse $null 'E_HELPER_START' $startupMessage } catch { }
    exit 1
}

try {
    $script:InputSize = [int][DshInput]::InputSize()
} catch {
    $script:InputSize = 0
}
if ($script:InputSize -ne 40) {
    try { [Console]::Error.WriteLine('warning: sizeof(INPUT)=' + $script:InputSize + ', expected 40 on x64') } catch { }
}

try {
    $previousContext = [DshInput]::SetDpiAware()
    $script:DpiAware = ([long]$previousContext -ne 0)
} catch {
    $script:DpiAware = $false
}

try {
    $script:Dpi = [int][DshInput]::SystemDpi()
    if ($script:Dpi -le 0) { $script:Dpi = 96 }
    $script:Scale = [Math]::Round(([double]$script:Dpi / 96.0), 4)
    if ($script:Scale -le 0) { $script:Scale = 1.0 }
    $screenBox = [DshInput]::VirtualScreenRect()
    $script:ScreenX = [int]$screenBox[0]
    $script:ScreenY = [int]$screenBox[1]
    $script:ScreenW = [int]$screenBox[2]
    $script:ScreenH = [int]$screenBox[3]
    $script:LogicalW = [int][Math]::Round(([double]$script:ScreenW / $script:Scale))
    $script:LogicalH = [int][Math]::Round(([double]$script:ScreenH / $script:Scale))
    $script:MonitorCount = [int][DshInput]::MonitorCount()
    if ($script:MonitorCount -le 0) { $script:MonitorCount = 1 }
    $script:Elevated = Get-ElevatedFlag
    $osInfo = Get-OsInfo
    $script:OsCaption = [string]$osInfo.caption
    $script:OsBuild = [string]$osInfo.build
} catch {
    $startupMessage = 'screen query failed: ' + $_.Exception.Message
    try { [Console]::Error.WriteLine((ConvertTo-AsciiMessage $startupMessage)) } catch { }
    try { Send-ErrorResponse $null 'E_HELPER_START' $startupMessage } catch { }
    exit 1
}

$initRequest = $null
try {
    $initRequest = Read-RequestLine
} catch {
    $initRequest = $null
}

$initOk = $false
$initId = $null
if ($null -ne $initRequest -and -not ($initRequest -is [hashtable])) {
    try {
        if (-not ($initRequest -is [System.Management.Automation.PSCustomObject])) { throw 'not an object' }
        $idProperty = $initRequest.PSObject.Properties['id']
        if ($null -ne $idProperty) { $initId = $idProperty.Value }
        $opProperty = $initRequest.PSObject.Properties['op']
        if ($null -ne $opProperty -and ([string]$opProperty.Value) -eq 'init') {
            $argsProperty = $initRequest.PSObject.Properties['args']
            $initArgs = $null
            if ($null -ne $argsProperty) { $initArgs = $argsProperty.Value }
            Initialize-Helper $initArgs
            $initOk = $true
        }
    } catch {
        $initOk = $false
    }
}

if (-not $initOk) {
    $startupMessage = 'first message must be a valid init command'
    try { [Console]::Error.WriteLine($startupMessage) } catch { }
    try { Send-ErrorResponse $initId 'E_HELPER_START' $startupMessage } catch { }
    exit 1
}

try {
    $initResponse = @{ id = $initId; ok = $true; result = (Build-InitResult) }
    Send-JsonMessage $initResponse
} catch {
    $startupMessage = 'init response failed: ' + $_.Exception.Message
    try { [Console]::Error.WriteLine((ConvertTo-AsciiMessage $startupMessage)) } catch { }
    try { Send-ErrorResponse $initId 'E_HELPER_START' $startupMessage } catch { }
    exit 1
}

# ---------------------------------------------------------- command loop ----

while ($true) {
    $request = $null
    try {
        $request = Read-RequestLine
    } catch {
        break
    }
    if ($null -eq $request) { break }

    if ($request -is [hashtable]) {
        try {
            Send-ErrorResponse $null 'E_PROTOCOL' 'message is not valid base64 JSON'
        } catch {
            break
        }
        continue
    }

    $requestId = $null
    $requestOp = ''
    $response = $null
    try {
        if (-not ($request -is [System.Management.Automation.PSCustomObject])) {
            Throw-Helper 'E_PROTOCOL' 'request must be a JSON object'
        }
        $idProperty = $request.PSObject.Properties['id']
        if ($null -ne $idProperty) { $requestId = $idProperty.Value }
        $opProperty = $request.PSObject.Properties['op']
        if ($null -eq $opProperty) { Throw-Helper 'E_PROTOCOL' 'missing op' }
        $requestOp = [string]$opProperty.Value
        $requestArgs = $null
        $argsProperty = $request.PSObject.Properties['args']
        if ($null -ne $argsProperty) { $requestArgs = $argsProperty.Value }
        $opResult = Invoke-CommandOp $requestOp $requestArgs
        $response = @{ id = $requestId; ok = $true; result = $opResult }
    } catch {
        $exception = $_.Exception
        $errorCode = Get-HelperErrorCode $exception
        $errorMessage = ConvertTo-AsciiMessage $exception.Message
        if ($errorCode -eq 'E_INPUT_FAILED') {
            try { [Console]::Error.WriteLine('command error (' + $requestOp + '): ' + $errorMessage) } catch { }
        }
        $response = @{
            id = $requestId
            ok = $false
            error = @{ code = $errorCode; message = $errorMessage }
        }
    }

    try {
        Send-JsonMessage $response
    } catch {
        break
    }
    if ($requestOp -eq 'quit') { break }
}

Release-All
try { [Console]::Out.Flush() } catch { }
exit 0
