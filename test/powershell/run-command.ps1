<#
.SYNOPSIS
    打开运行框，输入命令，然后让用户确认要点击的按钮。

.DESCRIPTION
    Win+R 打开运行对话框 → 输入命令 → 用 UI Automation 枚举对话框中
    的按钮（按 ClassName=Button 匹配，兼容 ControlType 异常的情况），
    展示按钮名称与坐标，让用户确认点哪一个（输入编号或按钮名称），
    最后移动鼠标到按钮中心点击。

.PARAMETER Command
    要输入的命令（如 devmgmt.msc）。

.PARAMETER Delay
    Win+R 后等待对话框出现的毫秒数（默认 800）。

.PARAMETER Button
    指定按钮名称，跳过交互确认直接点击（用于自动化调用）。
    例如 -Button "确定"。

.EXAMPLE
    .\run-command.ps1 -Command "devmgmt.msc"

.EXAMPLE
    .\run-command.ps1 -Command "devmgmt.msc" -Button "确定"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [int]$Delay = 800,

    [string]$Button
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("RunCommandHelper" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RunCommandHelper {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    private const uint INPUT_KEYBOARD = 1;
    private const uint INPUT_MOUSE = 0;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static bool PressWinR() {
        const ushort VK_LWIN = 0x5B;
        const ushort VK_R = 0x52;

        INPUT[] inputs = new INPUT[4];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].U.ki.wVk = VK_LWIN;
        inputs[1].type = INPUT_KEYBOARD; inputs[1].U.ki.wVk = VK_R;
        inputs[2].type = INPUT_KEYBOARD; inputs[2].U.ki.wVk = VK_R; inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[3].type = INPUT_KEYBOARD; inputs[3].U.ki.wVk = VK_LWIN; inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;

        return SendInput(4, inputs, Marshal.SizeOf(typeof(INPUT))) == 4;
    }

    public static bool TypeText(string text) {
        INPUT[] inputs = new INPUT[text.Length * 2];
        int n = 0;
        foreach (char c in text) {
            inputs[n].type = INPUT_KEYBOARD; inputs[n].U.ki.wScan = (ushort)c; inputs[n].U.ki.dwFlags = KEYEVENTF_UNICODE; n++;
            inputs[n].type = INPUT_KEYBOARD; inputs[n].U.ki.wScan = (ushort)c; inputs[n].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; n++;
        }
        return SendInput((uint)n, inputs, Marshal.SizeOf(typeof(INPUT))) == (uint)n;
    }

    public static bool ClickAt(int x, int y) {
        SetProcessDPIAware();
        if (!SetCursorPos(x, y)) return false;
        System.Threading.Thread.Sleep(50);

        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE; inputs[0].U.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inputs[1].type = INPUT_MOUSE; inputs[1].U.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
    }
}
"@
}

# 1. 打开运行框
if (-not [RunCommandHelper]::PressWinR()) {
    Write-Error "SendInput 失败（Win+R 未注入）"
    exit 1
}
Start-Sleep -Milliseconds $Delay

# 2. 输入命令
if (-not [RunCommandHelper]::TypeText($Command)) {
    Write-Error "SendInput 失败（文本未输入）"
    exit 1
}

# 3. 定位运行对话框（class #32770）
$root = [System.Windows.Automation.AutomationElement]::RootElement
$dlgCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "#32770")
$dlgColl = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $dlgCond)
$dialog = $null
foreach ($d in $dlgColl) {
    if ($d.Current.Name -match '运行|Run') { $dialog = $d; break }
}
if (-not $dialog -and $dlgColl.Count -gt 0) { $dialog = $dlgColl[0] }

if (-not $dialog) {
    Write-Error "找不到运行对话框"
    exit 1
}

# 4. 枚举按钮（匹配 ClassName=Button，兼容 UIA 把按钮报成 Pane 的情况）
$typeCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$classCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "Button")
$orCond = New-Object System.Windows.Automation.OrCondition($typeCond, $classCond)
$btnColl = $dialog.FindAll([System.Windows.Automation.TreeScope]::Subtree, $orCond)

$buttons = @()
foreach ($b in $btnColl) {
    $rect = $b.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $buttons += [PSCustomObject]@{
        Name    = $b.Current.Name
        Enabled = $b.Current.IsEnabled
        X       = [int]($rect.X + $rect.Width / 2)
        Y       = [int]($rect.Y + $rect.Height / 2)
    }
}

if ($buttons.Count -eq 0) {
    Write-Error "运行框中未找到任何按钮"
    exit 1
}

# 5. 展示按钮
Write-Output ""
Write-Output "运行框中找到以下按钮："
for ($i = 0; $i -lt $buttons.Count; $i++) {
    $en = if ($buttons[$i].Enabled) { "可用" } else { "禁用" }
    Write-Output "  [$i] $($buttons[$i].Name) ($en) @ ($($buttons[$i].X), $($buttons[$i].Y))"
}
Write-Output ""

# 6. 选择按钮
$selected = $null

if ($Button) {
    $selected = $buttons | Where-Object { $_.Name -eq $Button } | Select-Object -First 1
    if (-not $selected) {
        Write-Error "未找到名为 [$Button] 的按钮"
        exit 1
    }
} else {
    $defaultIdx = 0
    for ($i = 0; $i -lt $buttons.Count; $i++) {
        if ($buttons[$i].Enabled) { $defaultIdx = $i; break }
    }

    $resp = Read-Host "请输入按钮编号或按钮名称（回车默认 [$defaultIdx] $($buttons[$defaultIdx].Name)）"

    if ($resp -match '^\d+$') {
        $n = [int]$resp
        if ($n -ge 0 -and $n -lt $buttons.Count) { $selected = $buttons[$n] }
    } elseif ($resp) {
        $selected = $buttons | Where-Object { $_.Enabled -and $_.Name -like "*$resp*" } | Select-Object -First 1
    }

    if (-not $selected) { $selected = $buttons[$defaultIdx] }
}

# 7. 移动鼠标到按钮中心并点击
Write-Output "点击按钮: $($selected.Name) @ ($($selected.X), $($selected.Y))"
if (-not [RunCommandHelper]::ClickAt($selected.X, $selected.Y)) {
    Write-Error "点击失败"
    exit 1
}
Write-Output "已点击按钮: $($selected.Name)"
