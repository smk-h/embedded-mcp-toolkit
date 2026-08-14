<!-- more -->

## 一、 脚本说明

下表汇总了 `test/scripts` 目录下各脚本的用途与用法，按功能目录分类展示。

<table>
  <thead>
    <tr>
      <th>目录</th>
      <th>脚本</th>
      <th>说明</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td rowspan="8">serial</td>
      <td><a href="serial/basic-demo.mjs">basic-demo.mjs</a></td>
      <td>串口打开 / 发送 / 读取 / 关闭的基本用法演示</td>
    </tr>
    <tr>
      <td><a href="serial/terminal.mjs">terminal.mjs</a></td>
      <td>串口交互式终端，支持裸转发与行模式，类似 MobaXterm / minicom</td>
    </tr>
    <tr>
      <td><a href="serial/terminal-raw-test.mjs">terminal-raw-test.mjs</a></td>
      <td>terminal.mjs 裸转发模式的单元测试（行状态推算 / 透传行为）</td>
    </tr>
    <tr>
      <td><a href="serial/enter-uboot.mjs">enter-uboot.mjs</a></td>
      <td>监听串口数据，检测到 U-Boot 自动引导提示时自动进入命令行</td>
    </tr>
    <tr>
      <td><a href="serial/abort-zmodem.mjs">abort-zmodem.mjs</a></td>
      <td>设备端 rz/sz 卡在 ZMODEM 收发态时，发送 CAN×5 + BS×5 中止序列使其干净退出</td>
    </tr>
    <tr>
      <td><a href="serial/zmodem-timeout-test.mjs">zmodem-timeout-test.mjs</a></td>
      <td>ZMODEM 传输超时行为验证：上传超时中止、下载超时清理残缺文件</td>
    </tr>
    <tr>
      <td><a href="serial/uboot-detector-test.mjs">uboot-detector-test.mjs</a></td>
      <td>UbootDetector 离线验证脚本，覆盖 spec 的可离线部分用例</td>
    </tr>
    <tr>
      <td><a href="serial/uboot-state-detect.mjs">uboot-state-detect.mjs</a></td>
      <td>shell 状态检测逻辑测试（uboot / ready / locked / unlocking / error 等状态识别）</td>
    </tr>
    <tr>
      <td rowspan="2">ssh</td>
      <td><a href="ssh/exec-vs-shell-demo.mjs">exec-vs-shell-demo.mjs</a></td>
      <td>exec() 与 shell() 两种 SSH 会话方式的对比演示</td>
    </tr>
    <tr>
      <td><a href="ssh/shell-demo.mjs">shell-demo.mjs</a></td>
      <td>SSH 交互式 shell 演示：建立连接、打开交互 shell 并读写</td>
    </tr>
  </tbody>
</table>

---
*本文档由 markdowncli 技能辅助生成*
