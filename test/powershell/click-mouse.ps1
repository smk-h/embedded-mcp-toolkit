<#
.SYNOPSIS
    Move the mouse cursor to the specified screen coordinate and click.

.DESCRIPTION
    Uses P/Invoke: SetCursorPos to move, then SendInput to inject a
    mouse down/up at the current cursor position.

.PARAMETER X
    Target screen X coordinate.

.PARAMETER Y
    Target screen Y coordinate.

.PARAMETER Right
    Use right button instead of left.

.PARAMETER DoubleClick
    Send two clicks (left button only).

.PARAMETER DpiAware
    Call SetProcessDPIAware() first for correct coords on high-DPI displays.

.EXAMPLE
    .\click-mouse.ps1 -X 800 -Y 450

.EXAMPLE
    .\click-mouse.ps1 -X 800 -Y 450 -DoubleClick

.EXAMPLE
    .\click-mouse.ps1 -X 800 -Y 450 -Right -DpiAware
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$X,

    [Parameter(Mandatory = $true)]
    [int]$Y,

    [switch]$Right,

    [switch]$DoubleClick,

    [switch]$DpiAware
)

if (-not ("MouseClicker" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MouseClicker {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

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

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP  = 0x0010;

    public static bool Click(bool right) {
        uint down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up   = right ? MOUSEEVENTF_RIGHTUP   : MOUSEEVENTF_LEFTUP;

        INPUT[] inputs = new INPUT[2];
        inputs[0].type = 0; inputs[0].U.mi.dwFlags = down;
        inputs[1].type = 0; inputs[1].U.mi.dwFlags = up;
        uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        return sent == 2;
    }
}
"@
}

if ($DpiAware) {
    [MouseClicker]::SetProcessDPIAware() | Out-Null
}

$ok = [MouseClicker]::SetCursorPos($X, $Y)
if (-not $ok) {
    Write-Error "SetCursorPos failed for coordinates ($X, $Y)"
    exit 1
}

Start-Sleep -Milliseconds 50

$clicks = if ($DoubleClick) { 2 } else { 1 }
$clickOk = $true
for ($i = 0; $i -lt $clicks; $i++) {
    if (-not [MouseClicker]::Click($Right)) {
        $clickOk = $false
        break
    }
    Start-Sleep -Milliseconds 100
}

if (-not $clickOk) {
    Write-Error "SendInput failed (click not injected)"
    exit 1
}

$button = if ($Right) { "right" } elseif ($DoubleClick) { "left double" } else { "left" }
Write-Output "$button click at ($X, $Y)"
