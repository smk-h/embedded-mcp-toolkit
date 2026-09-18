# =====================================================
# MCP Server 进程清理脚本（embedded-mcp-toolkit）
#
#   扫描本机所有 MCP 进程并列出，由用户确认后整树结束，覆盖三种启动形态：
#     - node 本地 ： node.exe -> bin/embedded-mcp-toolkit-cli.js
#     - node 远程 ： sshd.exe -> cmd.exe(/c remote-start-mcp.bat) -> node.exe
#     - exe 形态  ： cmd.exe(/c remote-start-mcp.bat) -> embedded-mcp-toolkit.exe
#
#   匹配规则（任一命中即算目标）：
#     1. 进程名（镜像名）自带工具名 —— exe 形态就是这种：进程名叫
#        embedded-mcp-toolkit.exe，无论它放在哪、由谁拉起（bat / .mcp.json）
#        都能认出来，不依赖命令行内容；
#     2. 进程名是 node.exe / cmd.exe，且命令行命中关键字 —— node 形态靠脚本
#        路径（bin/embedded-mcp-toolkit-cli.js）认，中间那层 cmd.exe 靠 bat
#        路径（remote-start-mcp.bat）认，不论 bat 是本地起还是远程 ssh 起，
#        它都会作为进程树的根被包含进来。
#   其余进程一律不看：命令行里带项目路径的无关进程（explorer 打开项目目录、
#   编辑器 argv 里带路径等）不能因此被误杀。
#
#   node 不改进程名（bin 里的动态 import 也在同一进程内），所以 node 形态只能
#   靠命令行认；结束统一用 taskkill /T /F 按进程树递归——Node 的 proc.kill()
#   只杀本体，命令里起的子进程会变成孤儿（同 src/sdk/tools/win/powershell.ts、
#   cloudflared 停止逻辑的结论）。
#
#   输出只报进程名（img）与命令行，不区分本地/远程：本地同样可能用 bat 起，
#   区分意义不大，看命令行即可辨明来源。
#
#   用法：
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-mcp.ps1
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-mcp.ps1 -Force
#       -Force 跳过交互确认，直接全部结束（非交互场景，如串进其它脚本里跑）
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-mcp.ps1 -Utf8
#       -Utf8 从 Linux ssh 进来执行（对端终端是 UTF-8）时加，见第 0 节编码说明
#
#   兼容性（Windows 7 起 / Windows PowerShell 2.0 ~ 7.x 通吃）：
#     - 进程查询优先 Get-CimInstance，老系统没有 CimCmdlets（PS 2.0/3.0）时
#       自动回退 Get-WmiObject Win32_Process，两者都能取到 CommandLine；
#     - 不使用 PS 3.0+ 才有的 -in/-notin、[pscustomobject]、Get-CimInstance
#       -Filter，也不用 .NET 3.5+ 的泛型集合，集合统一用 Hashtable；
#     - 不使用 ?: / ?? / $IsWindows / $PSStyle 等 PS 6+ 语法；
#     - 本文件必须保持 UTF-8 with BOM：PS 5.1 及更早版本在没有 BOM 时按
#       ANSI/GBK 解析脚本，脚本里的中文一进来就是乱的（改文件别把 BOM 丢了）；
#     - 老系统默认执行策略多为 Restricted，调用时显式带 -ExecutionPolicy Bypass。
#
#   漏扫排查：如 MCP 换过启动方式（命令行里既没有 embedded-mcp-toolkit 也
#   没有 remote-start-mcp.bat），或 exe 被改过名（进程名不再是
#   embedded-mcp-toolkit.exe），用 -Keyword 追加关键字。
#   读不到命令行：他人/提权进程的 CommandLine 可能为空，需在管理员窗口运行。
# =====================================================
[CmdletBinding()]
param(
    [string[]]$Keyword = @(
        "embedded-mcp-toolkit",   # bin/embedded-mcp-toolkit-cli.js、打包 exe、项目路径
        "remote-start-mcp.bat",   # 远程 ssh 会话里拉起 MCP 的那个 cmd.exe
        "out\cli\index.js",       # npm start / 直接跑编译产物（相对路径不带项目名）
        "out/cli/index.js"
    ),
    [switch]$Force,               # 跳过交互确认
    [switch]$Utf8                 # 强制 chcp 65001 + UTF-8 输出（Linux ssh 场景）
)

$ErrorActionPreference = "Stop"

# 原生命令（taskkill）往 stderr 写东西时不当作终止错误——成败只看退出码。
# 该变量只在 PowerShell 7.3+ 存在，老版本 Test-Path 为假、跳过即可。
if (Test-Path Variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# -----------------------------------------------------
# 0. 输出编码（中文不乱码）
# -----------------------------------------------------
# 默认跟随实际控制台代码页：用 chcp 探测（中文系统一般 936/GBK），不写死、也
# 不无条件强制 UTF-8——管道里外部原生 exe（taskkill 等）按 CRT 代码页写字节，
# 强制 UTF-8 会把 GBK 字节读成 U+FFFD，跟随代码页才能让内置 cmdlet 与外部
# exe 输出同编码、调用方按同代码页解码（与 src/sdk/tools/win/powershell.ts
# 的结论一致）。chcp 的提示文字随系统语言本地化，但代码页数字始终是输出里
# 最后一段连续数字，与语言无关，所以只取数字就够。
if ($Utf8) {
    & chcp.com 65001 > $null
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
else {
    $CodePage = 0
    try {
        $runs = [regex]::Matches([string](& chcp.com 2>$null), '\d+')
        if ($runs.Count -gt 0) { $CodePage = [int]$runs[$runs.Count - 1].Value }
    }
    catch { }
    # 探测失败就保持默认（默认本就跟随控制台），别硬设成 UTF-8 —— 在 936 的
    # 控制台上设 UTF-8 输出反而是乱码
    if ($CodePage -gt 0) {
        try {
            [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding($CodePage)
        }
        catch { }
    }
}
# 交给原生命令 stdin 的编码保持一致（本脚本不喂原生命令，防患于未然）
$OutputEncoding = [Console]::OutputEncoding

# node 形态需要靠命令行认的镜像名（上层往往还套一层 cmd.exe：本地 bat 或
# 远程 ssh 都有可能）；exe 形态不在这里，它靠进程名自带工具名直接命中
# （-contains 比较不区分大小写）
$imageNames = @("node.exe", "cmd.exe")

# -----------------------------------------------------
# 工具函数
# -----------------------------------------------------

# 文本是否命中任一关键字（OrdinalIgnoreCase，避免路径大小写差异漏扫）
function Test-KeywordMatch {
    param([string]$Text)
    foreach ($k in $Keyword) {
        if ($Text.IndexOf($k, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

# 枚举全部进程：新系统走 CIM，老系统（PS 2.0/3.0 无 CimCmdlets）回退 WMI
function Get-ProcessList {
    if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
        return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    }
    return @(Get-WmiObject Win32_Process -ErrorAction SilentlyContinue)
}

# 从进程列表里筛出 MCP 进程（排除自身及祖先）
function Get-Target {
    param([object[]]$Processes, [hashtable]$Protected)
    $found = @()
    foreach ($p in $Processes) {
        if ($Protected.ContainsKey([int]$p.ProcessId)) { continue }
        $name = [string]$p.Name
        # exe 形态：进程名自带工具名（embedded-mcp-toolkit.exe），放哪都能认，
        # 不看命令行——bat 里那行就是裸的 `embedded-mcp-toolkit.exe`，路径信息
        # 依赖 cmd 搜索顺序，不能当作判据
        if (Test-KeywordMatch -Text $name) {
            $found += $p
            continue
        }
        # node / cmd 形态：只认这两个镜像名，且命令行要命中关键字，避免误杀
        if ($imageNames -notcontains $name) { continue }
        if (-not $p.CommandLine) { continue }
        if (Test-KeywordMatch -Text ([string]$p.CommandLine)) { $found += $p }
    }
    return $found
}

# -----------------------------------------------------
# 1. 采集进程 + 自身祖先链（防自杀）
# -----------------------------------------------------
$processes = Get-ProcessList
$byPid = @{}
foreach ($p in $processes) {
    $byPid[[int]$p.ProcessId] = $p
}

# 本脚本自身及其所有祖先一律排除：脚本本体、拉起它的 cmd / npm / node / 终端
# 都可能命中关键字（如 npm run 的 node npm-cli.js），杀了会中断自己。
$Protected = @{}
$Protected[$PID] = $true
$cursor = $PID
for ($i = 0; $i -lt 16; $i++) {
    $cur = $byPid[$cursor]
    if (-not $cur) { break }
    $parentId = [int]$cur.ParentProcessId
    if ($parentId -le 0) { break }
    if ($Protected.ContainsKey($parentId)) { break }
    $Protected[$parentId] = $true
    $cursor = $parentId
}

# -----------------------------------------------------
# 2. 扫描 + 展示
# -----------------------------------------------------
$targets = @(Get-Target -Processes $processes -Protected $Protected)
if ($targets.Count -eq 0) {
    Write-Host "未发现运行中的 MCP 进程（关键字：$($Keyword -join ' / ')）。"
    return
}

$targetIds = @{}
foreach ($p in $targets) {
    $targetIds[[int]$p.ProcessId] = $true
}

# 只保留「根」进程：父进程也命中的（链路里的 node.exe）交给父进程的
# taskkill /T 一起收，避免重复结束、以及父进程后退出时的二次报错。
$roots = @()
foreach ($p in $targets) {
    if (-not $targetIds.ContainsKey([int]$p.ParentProcessId)) { $roots += $p }
}

# 逐个分行打印，不用 Format-Table：中文字符在控制台是双宽字符，按字符数对齐的
# 表格列在中文内容下会参差不齐；分行还能把完整命令行打全，便于辨认来源。
Write-Host "发现 $($targets.Count) 个 MCP 进程（共 $($roots.Count) 棵进程树）："
$index = 0
foreach ($p in $targets) {
    $index++
    if ($targetIds.ContainsKey([int]$p.ParentProcessId)) {
        $note = "子进程，随父进程树一起结束"
    }
    else {
        $note = "根进程"
    }
    Write-Host ("  [{0}] PID={1} PPID={2} img={3} （{4}）" -f $index, $p.ProcessId, $p.ParentProcessId, $p.Name, $note)
    Write-Host ("      cmd: {0}" -f [string]$p.CommandLine)
}

# -----------------------------------------------------
# 3. 交互确认
# -----------------------------------------------------
if (-not $Force) {
    try {
        $answer = Read-Host "确认结束以上全部进程树？[y/N]"
    }
    catch {
        Write-Warning "当前会话无法交互输入，请改用 -Force 显式确认。"
        return
    }
    if ($answer -notmatch '^(y|yes)$') {
        Write-Host "已取消，未结束任何进程。"
        return
    }
}

# -----------------------------------------------------
# 4. 整树结束
# -----------------------------------------------------
$killed = 0
foreach ($p in $roots) {
    if (-not (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)) {
        Write-Host ("PID {0} 已自行退出，跳过" -f $p.ProcessId)
        continue
    }
    $ok = $false
    try {
        & taskkill /PID $p.ProcessId /T /F | Out-Null
        $ok = ($LASTEXITCODE -eq 0)
    }
    catch {
        Write-Warning ("taskkill PID {0} 报错：{1}" -f $p.ProcessId, $_.Exception.Message)
    }
    if ($ok) {
        $killed++
        Write-Host ("已结束进程树 PID {0} ({1})" -f $p.ProcessId, $p.Name)
    }
    else {
        Write-Warning ("结束 PID {0} ({1}) 失败，可能无权限（试试管理员窗口）" -f $p.ProcessId, $p.Name)
    }
}

# -----------------------------------------------------
# 5. 复查
# -----------------------------------------------------
Start-Sleep -Milliseconds 300
$leftover = @(Get-Target -Processes (Get-ProcessList) -Protected $Protected)
if ($leftover.Count -eq 0) {
    Write-Host "已结束 $killed 棵进程树，MCP 进程已全部清理。"
}
else {
    Write-Warning "仍有 $($leftover.Count) 个进程存活（权限不足或正处于启动竞态）："
    foreach ($p in $leftover) {
        Write-Warning ("  PID {0,-8} {1}" -f $p.ProcessId, $p.Name)
    }
    exit 1
}
