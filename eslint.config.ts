import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  tseslint.configs.recommended,
  // 自定义规则覆盖 (移除了与 Prettier 冲突的格式化规则)
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    rules: {
      semi: ["error", "always"], // 强制使用分号
      indent: ["error", 4], // 强制使用2个空格缩进
    },
  },
  // 禁用与 Prettier 冲突的规则
  eslintConfigPrettier,
  // Prettier 集成 - 使用 Prettier 规则并覆盖其他格式化规则
  eslintPluginPrettierRecommended,
  // ==================== 忽略的目录 ====================
  // 这些目录不进行 ESLint 检查
  {
    ignores: [
      "**/dist/", // 构建输出目录
      "**/temp/", // 临时文件目录
      "**/coverage/", // 测试覆盖率报告目录
      ".idea/", // JetBrains IDE 配置目录
      "explorations/", // 实验性代码目录
      "dts-build/packages", // DTS 构建产物目录
    ],
  },
]);
