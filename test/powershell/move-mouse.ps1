<#
.SYNOPSIS
    Move the mouse cursor to the specified screen coordinate.

.DESCRIPTION
    Uses P/Invoke to call SetCursorPos from user32.dll.
    With -DpiAware, calls SetProcessDPIAware() first so coordinates stay
    correct on high-DPI displays.

.EXAMPLE
    .\move-mouse.ps1 -X 800 -Y 450

.EXAMPLE
    .\move-mouse.ps1 -X 800 -Y 450 -DpiAware -Report
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$X,

    [Parameter(Mandatory = $true)]
    [int]$Y,

    [switch]$DpiAware,

    [switch]$Report
)

if (-not ("MouseMover" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MouseMover {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public struct POINT { public int X; public int Y; }
}
"@
}

if ($DpiAware) {
    [MouseMover]::SetProcessDPIAware() | Out-Null
}

$ok = [MouseMover]::SetCursorPos($X, $Y)
if (-not $ok) {
    Write-Error "SetCursorPos failed for coordinates ($X, $Y)"
    exit 1
}

if ($Report) {
    $p = New-Object MouseMover+POINT
    [MouseMover]::GetCursorPos([ref]$p) | Out-Null
    Write-Output "Moved mouse to target ($X, $Y); actual position ($($p.X), $($p.Y))"
} else {
    Write-Output "Mouse moved to ($X, $Y)"
}
