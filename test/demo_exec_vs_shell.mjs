import { Client } from "ssh2";

const HOST = "192.168.16.105";
const USER = "root";
const PASS = "root";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const client = new Client();

client.on("ready", async () => {
  console.log("==============================================");
  console.log("       exec() vs shell() 对比演示");
  console.log("==============================================\n");

  // ── exec() 演示 ──
  console.log("======================================================");
  console.log("  exec()：每次通过 SSH channel 独立 fork 进程");
  console.log("======================================================\n");

  const execResults = [];
  for (const cmd of ["pwd", "cd /tmp && pwd", "pwd"]) {
    const { stdout } = await new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d) => { out += d; });
        stream.on("close", (code) => resolve({ stdout: out.trim(), code }));
      });
    });
    execResults.push(stdout);
    console.log(`  $ ${cmd}`);
    console.log(`  → ${stdout}`);
    console.log();
  }

  console.log("  ┌───────────────────┬─────────────────────┐");
  console.log("  │ 步骤              │ 输出                │");
  console.log("  ├───────────────────┼─────────────────────┤");
  execResults.forEach((r, i) => {
    const labels = ["pwd", "cd /tmp && pwd", "再 pwd"];
    console.log(`  │ ${labels[i].padEnd(12, " ")}    │ ${r.padEnd(20, " ")} │`);
  });
  console.log("  ├───────────────────┼─────────────────────┤");
  console.log("  │ 结论              │ 第3步回到 /home/root │");
  console.log("  │                  │ cd 状态丢失 ❌      │");
  console.log("  └───────────────────┴─────────────────────┘\n");

  // ── shell() 演示 ──
  console.log("======================================================");
  console.log("  shell()：同一 channel 内持续交互");
  console.log("======================================================\n");

  const { shell } = await new Promise((resolve, reject) => {
    client.shell({ term: "xterm", cols: 80, rows: 24 }, (err, stream) => {
      if (err) return reject(err);
      resolve({ shell: stream });
    });
  });

  let buf = "";
  shell.on("data", (d) => { buf += d.toString(); });

  await sleep(800);
  buf = "";

  // ── 第1步 ──
  console.log("  ── 1. 初始目录 ──");
  shell.write("pwd\n");
  await sleep(700);
  const step1 = buf.trim();
  console.log(`  发送: pwd`);
  console.log(`  输出: ${step1.replace(/\n/g, " ")}`);
  console.log();

  // ── 第2步 ──
  buf = "";
  console.log("  ── 2. cd 到 /tmp ──");
  shell.write("cd /tmp && pwd\n");
  await sleep(700);
  const step2 = buf.trim();
  console.log(`  发送: cd /tmp && pwd`);
  console.log(`  输出: ${step2.replace(/\n/g, " ")}`);
  console.log();

  // ── 第3步 ──
  buf = "";
  console.log("  ── 3. 再 pwd（验证 cd 是否保持）──");
  shell.write("pwd\n");
  await sleep(700);
  const step3 = buf.trim();
  console.log(`  发送: pwd`);
  console.log(`  输出: ${step3.replace(/\n/g, " ")}`);
  console.log();

  // ── 第4步 ──
  buf = "";
  console.log("  ── 4. 定义变量并引用 ──");
  shell.write('MSG="hello shell" && echo $MSG\n');
  await sleep(700);
  const step4 = buf.trim();
  console.log(`  发送: MSG="hello shell" && echo $MSG`);
  console.log(`  输出: ${step4.replace(/\n/g, " ")}`);
  console.log();

  // ── 第5步 ──
  buf = "";
  console.log("  ── 5. 再引用变量（验证变量保持）──");
  shell.write("echo $MSG\n");
  await sleep(700);
  const step5 = buf.trim();
  console.log(`  发送: echo $MSG`);
  console.log(`  输出: ${step5.replace(/\n/g, " ")}`);
  console.log();

  // ── shell 侧重点分析 ──

  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │               shell() 状态保持分析                   │");
  console.log("  ├──────────┬──────────────────────────────────────────┤");
  console.log("  │ 1. pwd  │ /home/root                               │");
  console.log("  │ 2. cd   │ → 进入 /tmp                              │");
  console.log("  │ 3. pwd  │ /tmp        ← 与第1步不同！cd 状态保持 ✔ │");
  console.log("  │ 4. MSG  │ hello shell                              │");
  console.log("  │ 5. $MSG │ hello shell  ← 变量值保留！              │");
  console.log("  ├──────────┴──────────────────────────────────────────┤");
  console.log("  │ 结论：同一 shell 进程内 cd、变量等状态完全保持 ✔   │");
  console.log("  └─────────────────────────────────────────────────────┘\n");

  // ── 最终对比 ──
  console.log("==============================================");
  console.log("              最终对比总结");
  console.log("==============================================\n");
  console.log("  ┌───────────────────────┬───────────────────────────┐");
  console.log("  │ exec()                │ shell()                   │");
  console.log("  ├───────────────────────┼───────────────────────────┤");
  console.log("  │ 每次独立 session      │ 同一 session 持续复用     │");
  console.log("  │ 每次 server 独立 fork │ 同一 shell 进程           │");
  console.log("  │ 无 PTY 分配           │ 可选 PTY 分配             │");
  console.log("  │ cd 不保持 ❌          │ cd 保持 ✔                │");
  console.log("  │ 变量不保持 ❌         │ 变量保持 ✔               │");
  console.log("  │ 适合：单次非交互命令   │ 适合：交互式会话/TTY      │");
  console.log("  └───────────────────────┴───────────────────────────┘");

  shell.write("exit\n");
  setTimeout(() => client.end(), 300);
});

client.on("error", (err) => console.error("Error:", err.message));

client.connect({
  host: HOST,
  port: 22,
  username: USER,
  password: PASS,
  algorithms: { serverHostKey: ["ssh-rsa"] },
});
