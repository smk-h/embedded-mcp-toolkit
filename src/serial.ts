import { SerialPort } from "serialport";
import { MAX_BUFFER_SIZE, interactiveLoop } from "./common.js";

/**
 * @brief 串口 Shell 连接配置
 *
 * @param port     串口设备路径（如 COM3、/dev/ttyUSB0）
 * @param baudRate 波特率（默认 115200）
 * @param dataBits 数据位（5/6/7/8，默认 8）
 * @param stopBits 停止位（1/1.5/2，默认 1）
 * @param parity   校验位（none/even/odd，默认 none）
 */
export interface SerialShellConfig {
  port: string;
  baudRate?: number;
  dataBits?: 8 | 5 | 6 | 7;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd";
  /** 命令追加的换行符（\n, \r\n），默认 \n */
  lineEnding?: string;
}


/**
 * @brief 串口交互式 Shell 管理器
 *
 * 提供 open / write / read / close 四个核心方法，
 * 通过串口与远端建立交互式 shell 会话，
 * 内部维护输出缓冲区，支持命令发送与输出读取。
 */
export class SerialShell {
  #serialPort: SerialPort | null = null;
  #buffer = "";

  #collecting = false;     // 是否开启输出收集，open/write 控制
  #overflow = false;       // 缓冲区满时是否覆盖最早数据（clear=0 时为 true，允许覆盖）
  #config: SerialShellConfig; // 串口连接配置

  /**
   * @brief 构造函数
   * @param config 串口连接配置
   */
  constructor(config: SerialShellConfig) {
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
   * @brief 打开串口连接并启动交互式 shell
   *
   * 打开串口设备，注册数据监听。
   * 此时不收集输出数据，需调用 write() 后才开始收集。
   *
   * @return 串口启动时的初始输出（banner / prompt）
   */
  async open(): Promise<string> {
    const serialPort = new SerialPort({
      path: this.#config.port,
      baudRate: this.#config.baudRate ?? 115200,
      dataBits: (this.#config.dataBits ?? 8) as 8 | 5 | 6 | 7,
      stopBits: (this.#config.stopBits ?? 1) as 1 | 1.5 | 2,
      parity: (this.#config.parity ?? "none") as "none" | "even" | "odd",
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      serialPort.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    this.#serialPort = serialPort;
    this.#collecting = false;

    serialPort.on("data", (data: Buffer) => {
      this.#appendBuffer(data.toString());
    });
    serialPort.on("close", () => {
      this.#serialPort = null;
    });
    serialPort.on("error", () => {
      this.#serialPort = null;
    });

    // 收集 banner 后停止
    this.#collecting = true;
    await new Promise((r) => setTimeout(r, 500));
    const banner = this.#buffer;
    this.#buffer = "";
    this.#collecting = false;
    this.#overflow = false;
    return banner;
  }

  /**
   * @brief 向串口 shell 发送命令
   *
   * 发送命令到串口执行，同时控制缓冲区的清空与溢出行为。
   *
   * @param cmd   要执行的命令字符串
   * @param clear 清空标志，控制缓冲区行为：
   *              - 1（默认）：清空缓冲区后开始收集，写满时丢弃新数据
   *              - 0：不清空缓冲区，继续追加写入，写满时覆盖最早的数据
   */
  write(cmd: string, clear: number = 1): void {
    if (!this.#serialPort || !this.#serialPort.isOpen) {
      throw new Error("Serial not open. Call open() first.");
    }
    if (clear) {
      this.#buffer = "";
      this.#overflow = false;
    } else {
      this.#overflow = true;
    }
    this.#collecting = true;
    this.#serialPort.write(`${cmd}${this.#config.lineEnding ?? "\n"}`);
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
    }
    return data;
  }

  /**
   * @brief 关闭串口连接
   *
   * 释放所有资源，清空缓冲区。
   */
  async close(): Promise<void> {
    if (this.#serialPort) {
      const port = this.#serialPort;
      this.#serialPort = null;
      await new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          try { port.destroy(); } catch { /* ignore */ }
          resolve();
        }, 2000);
        port.close((err) => {
          clearTimeout(timeout);
          if (err) console.error("Serial close error:", err.message);
          resolve();
        });
      });
    }
    this.#buffer = "";
    this.#collecting = false;
    this.#overflow = false;
  }
}

/**
 * @brief 交互式串口 Shell 命令行入口
 *
 * 打开串口连接，从标准输入循环读取命令并发送，
 * 读取输出并显示，按 Ctrl+C 时断开连接并退出。
 *
 * @param config 串口连接配置
 */
export async function interactiveSerialShell(config: SerialShellConfig): Promise<void> {
  const shell = new SerialShell(config);

  const banner = await shell.open();
  if (banner) process.stdout.write(banner);
  console.log("\n--- Serial shell ready. Send commands with write(), read() to get output. ---\n");

  await interactiveLoop(shell, "serial");
}
