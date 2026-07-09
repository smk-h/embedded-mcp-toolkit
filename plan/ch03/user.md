# ch03 用户需求：配置文件分文件化

## 背景现象

当前所有设备配置集中在单个文件 `.embedded/configs/config.yaml` 中。实测统计：

- `keyProvider` 段重复出现 **14 次**（每个设备的 `ssh` + `serial` 各一份）。
- 每段含 4~5 个字段（`mode` / `challengeFilePath` / `keyFilePath` / `pollInterval` / `timeout`）。
- 文件已有 6~7 个设备、191 行，且设备数会继续增长。

## 痛点

1. **单文件过长**：新增设备时文件持续膨胀，定位/修改某个特定设备需要在长文件中滚动翻找。
2. **改动耦合**：修改某台设备配置时，整个大文件都处于"正在编辑"状态，Git 层面易产生不必要的 diff 噪声，多人维护时容易冲突。
3. **设备画像不自包含**：要了解某台设备的完整配置，必须在脑海中拼凑同一文件内相距较远的多个片段。

## 关键前提

用户明确澄清：**各设备的配置参数本质上并不相同**（host / port / 用户名 / 密码 / 串口号 / keyProvider 各异）。当前文件里多台设备配置看起来相同，**只是测试期间为方便而临时写的一样**，并非真实业务上的同质数据。

这一前提直接影响方案选择：

- 既然参数本质不同，就不存在"真正可继承的公共默认值"，靠默认值继承（方案 B）能压缩的字段极少，投入产出比低。
- "配置变长"的本质是**每个设备的真实信息量**，无法压缩；问题不是"重复太多"，而是"组织方式不便于定位和增长"。

## 选定方向

采用 **方案 C：按设备拆分为独立文件**，让每台设备的配置自包含、可独立增删。

### 目标结构

```
.embedded/configs/
├── config.yaml              # 主配置：default 设备名 + 全局设置
└── devices/
    ├── board-a.yaml         # 每设备一个文件，自包含
    ├── board-b.yaml
    └── board-test.yaml
```

### 每个设备文件的形态

```yaml
# devices/board-a.yaml —— 该设备的完整、自包含配置
ssh:
  host: "192.168.16.103"
  port: 22
  username: "root"
  password: "root"
  keyProvider:
    mode: "file"
    challengeFilePath: "./.embedded/configs/challenge.txt"
    keyFilePath: "./.embedded/configs/password_input.txt"
    pollInterval: 500
    timeout: 120000
serial:
  port: "COM4"
  baudRate: 115200
  loginUsername: "root"
  loginPassword: "root"
  keyProvider:
    mode: "file"
    pollInterval: 500
    timeout: 120000
adb:
  serialNo: "sn_none"
```

## 兼容性要求

- **加载性能不退化**：分文件后引入多次 `readFileSync`，但因配置层有进程级单例缓存（`_cached`，启动时加载一次后整会话复用），单次加载的亚毫秒级增量在整个 MCP server 生命周期中可忽略。此项不构成阻碍。
- **对外行为不变**：MCP 工具调用、`DEVICE` 环境变量、`resolveDeviceName()` / `listDevices()` 等对外语义保持不变。
- **现有设备配置不丢失**：迁移后，当前 `config.yaml` 中的全部设备配置必须无损失地落到对应设备文件中。

## 范围边界

- **本次只做分文件化**，不引入默认值继承（方案 B）、YAML 锚点（方案 A）等其他机制，避免一次改动引入多种约定。
- **不改配置文件格式**（仍为 YAML，不转 JSON）。
- **不改对外工具行为**，仅重构配置的存储与加载方式。
