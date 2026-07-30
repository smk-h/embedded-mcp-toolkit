# 远程 MCP 启动时的端点提示 Checklist

> 每一项通过运行代码或观察行为来验证,聚焦系统行为。与实现解耦——代码重构但行为不变时,checklist 依然适用。

## 实现完整性
- [ ] 端点解析模块可被调用并返回结构化结果(验证:`npm run build` 编译通过;node REPL 调用 `resolveHostEndpoint()` 返回含 scenario/username/hostIp/endpoint/source 五字段的对象)
- [ ] host_info 工具已注册且可被调用(验证:`npm run build` 编译通过;工具列表中出现 host_info)
- [ ] instructions 在远程 SSH 启动时被注入端点信息,本地启动时不注入(验证:见「集成」段)

## 集成
- [ ] server.ts 在构造 McpServer 时传入 instructions,且依据场景取值(验证:`npm run build` 通过;远程启动时 AI 客户端通过 initialize 握手能读到端点)
- [ ] host_info 工具返回的端点与 instructions 注入的端点一致(验证:两处都来自同一 `resolveHostEndpoint()` 缓存结果)
- [ ] host_info 已加入 mcpBasicTools 注册数组(验证:编译通过 + 工具列表含 host_info)

## 编译与测试
- [ ] 项目编译无错误(验证:`npm run build` 退出码 0)
- [ ] 代码符合 plan.md 中声明的 ts-lang-spec 要求(验证:加载 ts-lang-spec 技能,人工检查命名/风格/注释/类型标注)
- [ ] 文件编码未被破坏(验证:
  - 新建文件 host-endpoint.ts / host-info.ts 符合 ts-lang-spec 编码声明(默认 UTF-8 无 BOM + LF),用 `head -c 3 <file> | od -An -tx1` 核对无 `efbbbf`
  - 修改的 server.ts 保持原编码:`head -c 3 src/mcp/server.ts | od -An -tx1` 仍为 `efbbbf`(有 BOM);`grep -c $'\r' src/mcp/server.ts` 与改动前行数一致(CRLF)
  - 修改的 index.ts 保持原编码:`head -c 3` 无 BOM;CRLF 行数与改动前一致)

## 场景一:本地启动(AC1 / F5 / N4 —— 核心保护项)
- [ ] 本地启动 MCP,行为与改动前一致(验证:`process.env.SSH_CONNECTION` 未设置时启动,启动日志与改动前逐字可比对;工具列表与改动前一致;各工具正常工作)
- [ ] 本地启动调用 host_info 返回"local started"而非端点(验证:对 MCP 调 host_info,返回文本含 `Host: local started` 与 `Endpoint: (local, no scp needed)`,不含 username@ip)
- [ ] 本地启动时 instructions 未注入端点(验证:本地启动时 `instructions` 变量值为 undefined;若有手段观察 initialize 响应则确认其不含端点)

## 场景二:远程 SSH 启动(AC2 / F2 / F3 / F4)
- [ ] 远程 SSH 启动,端点解析与 SSH_CONNECTION 一致(验证:设 `SSH_CONNECTION="1.2.3.4 11111 5.6.7.8 22"`、`USER=20380`,调 resolveHostEndpoint 或 host_info,endpoint 为 `20380@5.6.7.8`——注意:server-ip 取第 3 字段 5.6.7.8,不是第 1 字段)
- [ ] host_info 远程启动返回完整端点信息(验证:调 host_info,返回文本含 `Endpoint: <user>@<ip>`、`Source: ssh_connection`)
- [ ] instructions 远程启动注入了端点(验证:initialize 握手响应的 instructions 字段含 username@host)

## 场景三:降级容错(AC5 / N2)
- [ ] SSH_CONNECTION 格式异常时 MCP 正常启动(验证:设 `SSH_CONNECTION="malformed"` 启动,进程不崩溃;resolveHostEndpoint 返回 scenario:"remote-ssh"、endpoint:null、source:"unavailable")
- [ ] host_info 在解析失败时返回 unavailable 状态(验证:调 host_info,返回文本含 `Endpoint: (unavailable)`、`Source: unavailable`,不抛错)

## 场景四:执行框架措辞(AC6 / AC7 / AC8 —— 迭代 2 真机修复)
- [ ] host_info 远程场景文本含完整执行框架(验证:远程启动调 host_info,返回文本含:① "AI client" + "Linux" 位置说明;② scp pull 骨架 `scp -i ~/.ssh/id_mcp_server <endpoint>:"..." ~/`;③ scp push 骨架;④ "Do NOT use power_shell" 提示)
- [ ] host_info local 场景文本不变(验证:本地启动调 host_info,返回文本与迭代 1 完全一致,不含 Usage/scp 指引)
- [ ] instructions 远程场景含完整执行框架(验证:远程启动时 instructions 变量文本含:claude 在 Linux、MCP 在 Windows、scp 正确方向含 `-i ~/.ssh/id_mcp_server`、勿用 power_shell 跨机;端点已填实)
- [ ] AC8:scp 骨架均含免密私钥(验证:host_info 与 instructions 的 scp 命令骨架都含 `-i ~/.ssh/id_mcp_server`)
- [ ] instructions local 场景仍为 undefined(验证:本地启动 instructions 为 undefined,零影响不变)
- [ ] 真机回归:claude 收到指引后不再误用 power_shell 跨机且 scp 带 `-i`(验证:再次让 claude "把 win 的文件下载到本地",观察其用自身 Linux shell 执行带 `-i ~/.ssh/id_mcp_server` 的正确方向 scp)
