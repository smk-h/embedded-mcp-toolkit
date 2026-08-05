<#
.SYNOPSIS
    Track the current mouse cursor position in real time.

.DESCRIPTION
    Uses P/Invoke to call GetCursorPos from user32.dll in a polling loop,
    printing the current screen coordinates. Exit with Ctrl+C.

.PARAMETER Interval
    Polling interval in milliseconds (default: 200).

.PARAMETER Count
    Number of samples to print, then exit. Omit to run forever until Ctrl+C.

.EXAMPLE
    .\get-mouse-pos.ps1

.EXAMPLE
    .\get-mouse-pos.ps1 -Interval 100

.EXAMPLE
    .\get-mouse-pos.ps1 -Interval 500 -Count 10
#>
[CmdletBinding()]
param(
    [int]$Interval = 200,

    [int]$Count = 0
)

if (-not ("MousePosTracker" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MousePosTracker {
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    public struct POINT { public int X; public int Y; }
}
"@
}

$p = New-Object MousePosTracker+POINT
$n = 0

try {
    while ($true) {
        [MousePosTracker]::GetCursorPos([ref]$p) | Out-Null
        $ts = Get-Date -Format "HH:mm:ss.fff"
        Write-Output "$ts  ($($p.X), $($p.Y))"

        $n++
        if ($Count -gt 0 -and $n -ge $Count) {
            break
        }
        Start-Sleep -Milliseconds $Interval
    }
}
finally {
    if ($Count -gt 0) {
        Write-Output "Tracked $n samples."
    }
}
