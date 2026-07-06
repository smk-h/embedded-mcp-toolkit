import { MAX_BUFFER_SIZE } from "../shared/constants.js";

/**
 * @brief 输出缓冲区管理器
 *
 * 封装四个传输类（SSHShell / SerialShell / AdbShell / PowerShellShell）共用的
 * 缓冲区逻辑：数据追加、溢出策略、收集开关、读取与排空。
 */
export class OutputBuffer {
  #buffer = "";
  #collecting = false;
  #overflow = false;

  /**
   * @brief 向缓冲区追加数据（由外部事件驱动）
   *
   * 本方法为同步函数，由传输层的 stream.on("data") 回调反复调用，
   * 本身不做异步等待。仅在收集状态开启时写入，溢出时根据 overflow 决定保留策略。
   *
   *   collecting │ overflow │ 缓冲区未满 │ 缓冲区已满（>1MB）   │ 使用场景
   *   ───────────┼──────────┼───────────┼───────────────────────┼──────────────────────────
   *    false     │    —     │   丢弃     │   丢弃                 │ close() 后、banner 捕获前
   *    true      │  false   │   追加     │   丢弃新数据，保留头部   │ 单次命令（如 cat /proc/cpuinfo）
   *    true      │  true    │   追加     │   覆盖最早数据，保留尾部 │ 监控日志、编译输出等持续追加
   *
   * @param data 待追加的文本数据
   */
  append(data: string): void {
    if (!this.#collecting) {
      return;
    }
    // 先追加再截断：buffer 会短暂超过 MAX_BUFFER_SIZE，然后根据 overflow 策略决定保留哪部分
    // 假设已满 1MB，又追加 100B → 1MB+100B
    //   overflow=true  → slice(-1MB) → 丢掉开头 100B 旧数据，保留末尾 1MB（含新数据）
    //   overflow=false → substring(0, 1MB) → 丢掉末尾 100B 新数据，保留开头 1MB（旧数据不变）
    this.#buffer += data;
    if (this.#buffer.length > MAX_BUFFER_SIZE) {
      if (this.#overflow) {
        // 覆盖模式（clear=0）：丢弃旧数据，保留尾部最新数据 — 适合持续追加场景（如监控日志、编译输出）
        // slice(-N)：从末尾倒数第 N 个字符开始截取到结尾，等价于"保留最后 N 个字符"
        this.#buffer = this.#buffer.slice(-MAX_BUFFER_SIZE);
      } else {
        // 丢弃模式（clear=1）：丢弃新数据，保留头部已有数据 — 适合单次命令输出场景（开头通常更重要）
        // substring(0, N)：从开头截取到第 N 个字符（左闭右开 [0, N)），等价于"保留前 N 个字符"
        this.#buffer = this.#buffer.substring(0, MAX_BUFFER_SIZE);
      }
    }
  }

  /**
   * @brief 为 write 操作准备缓冲区状态
   *
   * 根据 clear 参数设置 overflow 和 collecting，同时控制 buffer 是否清空。
   *
   *   clear │ 写入前 buffer │ → overflow │ → collecting │ 效果                 │ 使用场景
   *   ──────┼───────────────┼────────────┼──────────────┼────────────────────┼─────────────────
   *    1    │    清空       │   false    │    true      │ 清空后收集，满后丢新   │ 普通单步执行命令
   *    0    │    保留       │   true     │    true      │ 追加收集，满后覆盖旧   │ 轮询编译输出等长任务
   *
   * @param clear 清空标志，1=清空后收集，0=追加收集
   */
  prepareWrite(clear: number): void {
    if (clear) {
      this.#buffer = "";
      this.#overflow = false;
    } else {
      this.#overflow = true;
    }
    this.#collecting = true;
  }

  /**
   * @brief 读取缓冲区内容
   *
   * 根据 clear 参数决定是否清空缓冲区、停止收集、重置溢出标志。
   *
   *   clear │ 返回数据 │ 读取后 buffer │ → overflow │ → collecting │ 效果         │ 使用场景
   *   ──────┼─────────┼───────────────┼────────────┼──────────────┼────────────┼─────────────────
   *    1    │  返回   │    清空       │   false    │    false     │ 读完停止收集 │ 单次命令取结果
   *    0    │  返回   │    不变       │   不变     │    不变      │ 读完继续收集 │ 轮询或事后 peek
   *
   * 注意：read(0) 不清理 buffer，每次返回 write() 后积累的全量内容。
   * 但如果 shell 输出尚未传输完毕，拿到的只是"目前为止收到的"，并非"全部的"。
   * 与 drain() 的区别：read(0) 仅查看不拿走，drain() 拿走并清空。
   *
   * @param clear 清空标志（默认 1）
   * @returns 缓冲区中的文本内容
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
   * @brief 排空缓冲区但不停止数据收集
   *
   * 返回当前缓冲区内容并清空，保持 collecting 状态不变。
   * 与 read(0) 的区别：drain() 拿走并清空，read(0) 仅查看不拿走。
   * 用于长时间命令执行期间持续接收输出数据（如 ssh_build 轮询）。
   *
   * @returns 缓冲区中的文本内容
   */
  drain(): string {
    const data = this.#buffer;
    this.#buffer = "";
    return data;
  }

  /**
   * @brief 开启输出收集
   */
  startCollecting(): void {
    this.#collecting = true;
  }

  /**
   * @brief 完全重置缓冲区状态
   *
   * 清空缓冲区内容、关闭收集、重置溢出标志。
   * 用于 close() 和 banner 捕获完成时。
   *
   * 重置后状态：buffer="" overflow=false collecting=false
   */
  reset(): void {
    this.#buffer = "";
    this.#collecting = false;
    this.#overflow = false;
  }
}
