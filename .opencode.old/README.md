# .opencode 目录说明

本目录由 [opencode](https://opencode.ai) 工具自动生成并管理，用于存放项目级配置和运行时依赖。

## 一、目录内容

| 文件/目录 | 说明 | 是否需要进 Git |
|---|---|---|
| `opencode.json` | opencode 项目配置文件（MCP Server、技能等） | **是** |
| `package.json` | opencode 插件依赖声明 | 否（已加入 .gitignore） |
| `node_modules/` | 插件运行时依赖包 | 否（已加入 .gitignore） |
| `package-lock.json` | npm 依赖锁定文件 | 否（已加入 .gitignore） |
| `skills/` | 自定义技能文件 | **是** |
| `.gitignore` | 本目录的忽略规则 | 可选 |

## 二、常见问题

### 1. 为什么存在 `package.json`？

当你在当前项目中启用了需要额外插件的 MCP Server（如 `embedded-board`、`board-beta`、`board-alpha`）时，opencode 会自动生成 `package.json` 并写入所需依赖（例如 `@opencode-ai/plugin`），以便加载对应功能。

### 2. 如何阻止自动安装？

如果你**不需要**这些 MCP 插件：

- **方法 A**：编辑 `opencode.json`，将对应 MCP Server 的 `enabled` 设为 `false`，然后删除 `package.json`、`package-lock.json` 和 `node_modules/`，opencode 便不会再自动安装。

- **方法 B**：直接删除 `package.json`、`package-lock.json` 和 `node_modules/`，但相关 MCP 功能将不可用。

> 注意：本目录下的 `node_modules`、`package.json`、`package-lock.json` 已经写入 `.gitignore`，它们不会被提交到版本控制中。

## 三、建议

- **保留** `opencode.json` 和 `skills/`（如果使用了自定义技能），这些是项目配置的一部分。
- **忽略** `node_modules/` 和 `package.json`，它们是运行时产物，不需要手动维护。
- 不要在本目录下手动修改 `package.json`，它由 opencode 自动管理。
