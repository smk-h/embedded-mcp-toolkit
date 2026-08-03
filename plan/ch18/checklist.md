# 跨机部署下的编译路由指引 Checklist

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。本方案无既有单测框架，验收以编译通过 + 行为观察 + 文本核对为主。

## 实现完整性
- [ ] 编译路由文本模块已创建且导出两个纯函数（验证：`npm run build` 通过，模块无入参、返回 string）
- [ ] `buildRoutingInstructions()` 返回单行文本，含 `cmdsift`、`make -j8`、`-C`、`./build.sh`、`log/YYYYMMDD_HHMMSS.log`、`ssh_build` 关键词（验证：人工核对文本，无换行）
- [ ] `buildRoutingHint()` 返回多行文本，含同样关键词且语义与单行版一致（验证：人工核对，有换行与缩进）
- [ ] `instructions` 注入点已追加编译路由（验证：读 `server.ts`，instructions 数组末尾含 `buildRoutingInstructions()` 调用）
- [ ] `host_info` 两个 remote 分支已追加编译路由（验证：读 `host-info.ts`，endpoint 成功分支与 unavailable 分支均含 `buildRoutingHint()`，local 分支不动）
- [ ] `ssh_build` 软拦截已实现（验证：读 `build.ts`，handler 顶部有场景判定，两返回分支前缀拼 `routingHint`）

## 集成
- [ ] 三处（instructions / host_info / ssh_build）引用同一文本模块，无重复硬编码（验证：grep `buildRoutingInstructions\|buildRoutingHint` 仅命中 build-routing.ts 定义 + 三处 import 调用，无其他内联文本副本）
- [ ] 场景判定复用 ch17 的 `resolveHostEndpoint()`，未新建判定逻辑（验证：grep 仅命中 host-endpoint.ts 定义 + server.ts/host-info.ts/build.ts 三处调用）

## 编译与测试
- [ ] 项目编译无错误（验证：`npm run build` 退出码 0，无报错输出）
- [ ] 无 TypeScript 类型告警（验证：build 输出无 warning）
- [ ] 代码符合 plan.md 中声明的 ts-lang-spec 要求（验证：人工检查命名/风格/JSDoc `@brief`/`@details` 注释风格与 host-endpoint.ts 一致）
- [ ] 文件编码未被破坏：新建 `build-routing.ts` 为 UTF-8 无 BOM、LF；修改的 `server.ts` / `host-info.ts` / `build.ts` 保持原编码与换行符不变（验证：用编码检测工具核对，无乱码、无 BOM 变化）

## 端到端场景
- [ ] **场景 1（方式一·本地启动，零改变，对应 AC1/F6）**：Windows 本地启动 MCP → instructions 为 undefined / host_info 返回 local 状态无编译路由 / 调用 ssh_build 无软拦截提示——三处行为与改动前逐字一致（验证：对比改动前后的工具返回文本）
- [ ] **场景 2（方式二·远程 SSH 启动，instructions 注入，对应 AC2/F2）**：经 SSH 桥接启动 MCP → 协议握手 instructions 文本含 cmdsift 编译路由（三类示例 + 日志落盘说明 + 不用 ssh_build 的理由）（验证：抓取 initialize 握手报文或在日志中观察注入结果）
- [ ] **场景 3（方式二·host_info 端点成功，对应 AC3/F3）**：远程 SSH 启动且端点解析成功 → host_info 返回文本在 scp 指引之后含编译路由指引（验证：调用 host_info，核对返回文本含 cmdsift 路由段）
- [ ] **场景 4（方式二·host_info 端点不可用，对应 AC4/F4）**：远程 SSH 启动但 SSH_CONNECTION 格式异常 → host_info 返回 (unavailable) 状态，文本仍含编译路由指引（验证：模拟异常 SSH_CONNECTION，调用 host_info 核对）
- [ ] **场景 5（方式二·ssh_build 软拦截，对应 AC5/F5）**：远程 SSH 启动，调用 ssh_build → 返回结果开头含软拦截提示，但编译照常执行、退出码正确透传、error/warning 分类结果不受影响（验证：调用 ssh_build 跑一个会出 warning 的编译，核对返回开头有提示、末尾有正常的 BUILD SUCCESS/FAILED + 分类列表）
- [ ] **场景 6（cmdsift 示例可执行，对应 AC6/F7）**：编译路由指引中的 cmdsift 示例命令（`cmdsift 'make -j8'` / `cmdsift -C /path 'make'` / `cmdsift './build.sh'`）形态与 cmdsift 实际 CLI 一致，可直接复制执行（验证：在装了 cmdsift 的 Linux 上复制示例命令运行，不报参数错误）

## 验收对照表（spec AC ↔ checklist）

| spec 验收标准 | 对应 checklist 条目 |
|---------------|---------------------|
| AC1（方式一零改变） | 场景 1 |
| AC2（instructions 含路由） | 场景 2 + 实现完整性第 2 项 |
| AC3（host_info 端点成功含路由） | 场景 3 |
| AC4（host_info unavailable 含路由） | 场景 4 |
| AC5（ssh_build 软拦截照常执行） | 场景 5 |
| AC6（cmdsift 示例正确） | 场景 6 |
| AC7（三处共享模块） | 集成第 1 项 |
