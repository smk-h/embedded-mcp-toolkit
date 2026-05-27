import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { MAX_BUFFER_SIZE } from "../infra/constants.js";
import { interactiveLoop } from "./loop.js";
import { sanitize } from "../utils/terminal-sanitizer.js";
import { PshHandler, PshState } from "./psh.js";
import { KeyProvider } from "../utils/key-provider.js";
import { getKeyProviderConfig } from "../infra/config.js";

/**
 * @brief SSH Shell 连接配置
 *
 * @param host     目标主机地址
 * @param port     SSH 端口，默认 22
 * @param username 登录用户名
 * @param password 密码认证（与 privateKey 二选一）
 * @param privateKey   密钥认证（与 password 二选一）
 * @param passphrase   密钥解密口令（privateKey 加密时需要）
 */
export interface SSHShellConfig {
	host: string;
	port?: number;
	username: string;
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

/**
 * @brief SSH 交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过 SSH 协议与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */
export class SSHShell {
	#client: Client | null = null;
	#stream: ClientChannel | null = null;
	#buffer = "";

	#collecting = false; // 是否开启输出收集，open/write 控制
	#overflow = false; // 缓冲区满时是否覆盖最早数据（clear=0 时为 true，允许覆盖）
	#config: SSHShellConfig; // SSH 连接配置

	/**
	 * @brief 构造函数
	 * @param config SSH 连接配置
	 */
	constructor(config: SSHShellConfig) {
		this.#config = config;
	}

	/**
	 * @brief 向缓冲区追加数据（内部方法）
	 *
	 * 根据 #collecting 和 #overflow 状态决定数据写入行为：
	 * - #collecting=false：未开启收集，丢弃数据
	 * - #collecting=true, #overflow=false（clear=1 模式）：
	 *   缓冲区满时丢弃新数据，保留已有内容
	 * - #collecting=true, #overflow=true（clear=0 模式）：
	 *   缓冲区满时覆盖最早的数据，保留最新内容
	 *
	 * @param data 待追加的文本数据
	 */
	#appendBuffer(data: string): void {
		if (!this.#collecting) return;
		this.#buffer += data;
		if (this.#buffer.length > MAX_BUFFER_SIZE) {
			if (this.#overflow) {
				// 覆盖模式：保留最新的 MAX_BUFFER_SIZE 字节
				this.#buffer = this.#buffer.slice(-MAX_BUFFER_SIZE);
			} else {
				// 丢弃模式：截断到 MAX_BUFFER_SIZE，丢弃溢出部分
				this.#buffer = this.#buffer.substring(0, MAX_BUFFER_SIZE);
			}
		}
	}

	/**
	 * @brief 打开 SSH 连接并启动交互式 shell
	 *
	 * 建立 SSH 连接，分配 PTY 伪终端，启动远端登录 shell。
	 * 此时不收集输出数据，需调用 write() 后才开始收集。
	 *
	 * @return shell 启动时的初始输出（banner / prompt）
	 */
	async open(): Promise<string> {
		const client = new Client(); // 创建 ssh2 Client

		await new Promise<void>((resolve, reject) => {
			client.on("ready", () => resolve());
			client.on("error", reject);
			// 用配置发起 TCP + SSH 握手连接
			client.connect({
				host: this.#config.host,
				port: this.#config.port ?? 22,
				username: this.#config.username,
				password: this.#config.password,
				privateKey: this.#config.privateKey,
				passphrase: this.#config.passphrase,
				readyTimeout: 10000,
			} as ConnectConfig);
		});

		this.#client = client;
		this.#collecting = false;
		// 连接成功后分配 PTY 伪终端（xterm, 80x24），启动远端 shell
		const stream = await new Promise<ClientChannel>((resolve, reject) => {
			client.shell({ term: "xterm", cols: 80, rows: 24 }, (err, stream) => {
				if (err) return reject(err);
				resolve(stream);
			});
		});
		// 监听 stream 的 data/stderr 事件，收集输出到内部缓冲区
		stream.on("data", (data: Buffer) => {
			this.#appendBuffer(data.toString());
		});
		stream.stderr.on("data", (data: Buffer) => {
			this.#appendBuffer(data.toString());
		});
		stream.on("close", () => {
			this.#stream = null;
		});

		this.#stream = stream;

		// 收集 banner 后停止
		this.#collecting = true;
		await new Promise((r) => setTimeout(r, 500)); // 等待 500ms 收集 banner（登录提示、motd 等），然后停止收集
		const banner = this.#buffer;
		this.#buffer = "";
		this.#collecting = false;
		this.#overflow = false;
		return banner; // 返回收集到的 banner 文本
	}

	/**
	 * @brief 向 shell 发送命令
	 *
	 * 发送命令到远端 shell 执行，同时控制缓冲区的清空与溢出行为。
	 *
	 * @param cmd   要执行的命令字符串
	 * @param clear 清空标志，控制缓冲区行为：
	 *              - 1（默认）：清空缓冲区后开始收集，写满时丢弃新数据
	 *              - 0：不清空缓冲区，继续追加写入，写满时覆盖最早的数据
	 */
	write(cmd: string, clear: number = 1): void {
		if (!this.#stream) throw new Error("Shell not open. Call open() first.");
		if (clear) {
			this.#buffer = "";
			this.#overflow = false;
		} else {
			this.#overflow = true;
		}
		this.#collecting = true;
		this.#stream.write(`${cmd}\n`);
	}

	/**
	 * @brief 读取缓冲区中的输出数据
	 *
	 * 返回缓冲区内容，并根据 clear 参数决定是否清空缓冲区。
	 *
	 * @param clear 清空标志，控制读取后缓冲区状态：
	 *              - 1（默认）：读取后清空缓冲区，下次 read() 返回新数据
	 *              - 0：读取后保留缓冲区内容，下次 read() 仍可获取相同数据
	 * @return 缓冲区中的文本内容
	 */
	read(clear: number = 1): string {
		const data = this.#buffer;
		if (clear) {
			this.#buffer = "";
			this.#overflow = false;
			this.#collecting = false;
		}
		return data;
	}

	/**
	 * @brief 关闭 shell 会话和 SSH 连接
	 *
	 * 释放所有资源，清空缓冲区。
	 */
	async close(): Promise<void> {
		if (this.#stream) {
			this.#stream.close();
			this.#stream = null;
		}
		if (this.#client) {
			this.#client.end();
			this.#client = null;
		}
		this.#buffer = "";
		this.#collecting = false;
		this.#overflow = false;
	}
}

/**
 * @brief 交互式 SSH Shell 命令行入口
 *
 * 打开 SSH 连接，从标准输入循环读取命令并发送，
 * 读取输出并显示，按 Ctrl+C 时断开连接并退出。
 *
 * @param config SSH 连接配置
 */
export async function interactiveShell(config: SSHShellConfig): Promise<void> {
	const shell = new SSHShell(config);

	const banner = await shell.open();
	if (banner) process.stdout.write(banner);
	console.log(
		"\n--- SSH shell ready. Send commands with write(), read() to get output. ---\n"
	);

	await interactiveLoop(shell, "ssh");
}

/**
 * @brief PSH 探测 + 解锁演示（SSH 方式）
 *
 * 流程：
 *   1. 连接 SSH，读取 banner
 *   2. 自动匹配 PSH profile（psh / psh_busybox）
 *   3. 探测当前 PSH 状态
 *   4. 如状态为 LOCKED，发送 debug 命令，
 *      将 QR 码 + Base64 Challenge 显示在终端
 *   5. 用户从终端输入密钥
 *   6. 发送密钥完成解锁，输出结果
 *
 * 环境变量：
 *   BOARD_HOST, BOARD_PORT, BOARD_USERNAME, BOARD_PASSWORD
 *
 * @param config SSH 连接配置
 */
export async function pshDemoSsh(config: SSHShellConfig): Promise<void> {
	// ===== 步骤 1：连接 SSH，读取启动信息（banner） =====
	console.log("[Step 1] === PSH Unlock Demo (SSH) ===\n");

	console.log(`[Step 1] Connecting to ${config.host}:${config.port ?? 22} ...`);
	const shell = new SSHShell(config);
	const banner = await shell.open();
	console.log("[Step 1] --- SSH Banner ---\n%s\n---", sanitize(banner));

	// ===== 步骤 2：自动识别 PSH profile =====
	const handler = PshHandler.matchFromOutput(banner);
	if (!handler) {
		console.log(
			"[Step 2] No PSH profile matched — shell may already be unlocked or not a PSH device."
		);
		await shell.close();
		return;
	}
	console.log(
		"[Step 2] Matched profile: %s (%s)\n",
		handler.profile.name,
		handler.profile.description
	);

	// ===== 步骤 3：探测当前状态 =====
	let detect = handler.detect(banner);
	console.log("[Step 3] Initial state : %s", detect.state);
	console.log("[Step 3] Is PSH        : %s", detect.isPsh);
	console.log(
		"[Step 3] Challenge     : %s\n",
		detect.challengeCode ?? "(none)"
	);

	if (detect.state === PshState.UNKNOWN) {
		console.log("[Step 3] State is UNKNOWN, sending probe command...");
		detect = await handler.probeState(shell);
		console.log("[Step 3] After probe   : %s", detect.state);
	}

	// ===== 步骤 4：根据状态执行对应操作 =====
	if (detect.state === PshState.LOCKED) {
		console.log("[Step 4] === Starting unlock sequence ===\n");

		const keyProvider = new KeyProvider(getKeyProviderConfig("ssh"));

		const result = await handler.unlock(
			shell,
			"", // key 参数用不到（走 onKeyRequest 回调）
			1500,
			(output: string) => keyProvider.getKey(output)
		);

		console.log("[Step 4] Unlock result:");
		console.log("            success      : %s", result.success);
		console.log("            state        : %s", result.state);
		console.log(
			"            challenge    : %s",
			result.challengeCode ?? "(none)"
		);
		console.log(
			"            attemptsLeft : %s",
			result.attemptsLeft ?? "(none)"
		);
		console.log("            error        : %s", result.error ?? "(none)");

		if (result.success) {
			console.log(
				"[Step 4] Unlock succeeded! Entering interactive shell. Type commands and press Enter. Press Ctrl+C to exit.\n"
			);
			await interactiveLoop(shell, "ssh");
		} else if (result.attemptsLeft && result.attemptsLeft > 0) {
			console.log(
				"[Step 4] Hint: wrong password, %d attempt(s) remaining. Re-run to try again.",
				result.attemptsLeft
			);
		}
	} else if (detect.state === PshState.READY) {
		console.log("[Step 4] Shell is already unlocked, no action needed.");
	} else if (detect.state === PshState.ERROR) {
		console.log(
			"[Step 4] Shell is in ERROR state (previous unlock may have failed)."
		);
	} else if (detect.state === PshState.UNLOCKING) {
		console.log(
			"[Step 4] Shell is in UNLOCKING state — a password prompt was left dangling."
		);
	}

	// ===== 步骤 5：解锁后验证（已在步骤 4 内完成） =====
	console.log("[Step 5] Post-unlock verification done");

	// ===== 步骤 6：关闭 SSH 连接，演示结束 =====
	console.log("[Step 6] === Demo complete ===");
	await shell.close();
}
