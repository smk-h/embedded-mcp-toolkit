<#
.SYNOPSIS
    Press the Win+R key combination (opens the Windows Run dialog).

.DESCRIPTION
    Uses P/Invoke SendInput to inject the Win key down, R key down,
    R key up, Win key up. Win = VK 0x5B, R = VK 0x52.
    The INPUT struct uses the Explicit union layout so its marshaled size
    matches the native INPUT (40 bytes on x64); otherwise SendInput fails
    with ERROR_INVALID_PARAMETER and nothing is injected.

.EXAMPLE
    .\press-win-r.ps1
#>
[CmdletBinding()]
param()

if (-not ("WinRKeyPresser" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WinRKeyPresser {
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

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    public static bool Press() {
        const ushort VK_LWIN = 0x5B;
        const ushort VK_R = 0x52;

        INPUT[] inputs = new INPUT[4];
        inputs[0].type = INPUT_KEYBOARD; inputs[0].U.ki.wVk = VK_LWIN;
        inputs[1].type = INPUT_KEYBOARD; inputs[1].U.ki.wVk = VK_R;
        inputs[2].type = INPUT_KEYBOARD; inputs[2].U.ki.wVk = VK_R; inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[3].type = INPUT_KEYBOARD; inputs[3].U.ki.wVk = VK_LWIN; inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;

        uint sent = SendInput(4, inputs, Marshal.SizeOf(typeof(INPUT)));
        return sent == 4;
    }
}
"@
}

if ([WinRKeyPresser]::Press()) {
    Write-Output "Win+R pressed"
} else {
    Write-Error "SendInput failed (Win+R not injected)"
    exit 1
}
