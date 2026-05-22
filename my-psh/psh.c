/** =====================================================
 * File name  : psh.c
 * Author     : psh-dev
 * Date       : 2026/05/22
 * Version    : 2.0.0
 * Description: Portal Shell (门禁Shell) v2.0
 *              工作模式:
 *                1. 启动后，终端可正常显示系统输出(syslog、内核消息等)
 *                2. 但无法执行普通命令，输入会提示"unsupported"
 *                3. 仅允许 dmesg、ps 两个只读诊断命令
 *                4. 输入 debug 显示 challenge 字符串和固定解锁密钥
 *                5. 输入密钥正确即可解锁 shell
 *
 * 编译: gcc -o psh psh.c
 * =====================================================
 */

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <ctype.h>

/* ==================== 配置宏定义 ==================== */

#define DEFAULT_SHELL     "/bin/sh"
#define MAX_INPUT_LEN     256
#define CHALLENGE_LEN     64

/* ==================== 全局状态变量 ==================== */

static char current_challenge[CHALLENGE_LEN + 1] = {0};
static int  authenticated = 0;
static int  challenge_generated = 0;

/* ==================== Challenge/Key 验证模块 ==================== */

/** @fn static void generate_challenge(char *output, size_t len)
 *  @brief 生成动态 challenge 字符串
 *  @param[out] output 输出缓冲区.
 *  @param[in]  len    缓冲区大小.
 */
static void generate_challenge(char *output, size_t len)
{
    struct timespec ts;
    unsigned long seed;

    clock_gettime(CLOCK_REALTIME, &ts);
    seed = (unsigned long)(ts.tv_nsec ^ getpid() ^ (ts.tv_sec>>4));
    srand(seed);
    snprintf(output, len, "PSH-%04X-%04X-%04X-%04X",
             rand()&0xFFFF, rand()&0xFFFF, rand()&0xFFFF, rand()&0xFFFF);
    challenge_generated = 1;
}

/** @fn static int verify_key(const char *user_key)
 *  @brief 验证用户输入的密钥是否正确(固定密钥模式)
 *  @param[in] user_key 用户输入的密钥字符串.
 *  @return 1=验证通过, 0=验证失败.
 */
static int verify_key(const char *user_key)
{
    if (!challenge_generated || current_challenge[0] == '\0') {
        return 0;
    }

    return (strcmp(user_key, "123456") == 0);
}

/** @fn static void print_debug_info(void)
 *  @brief 打印 challenge 信息和解锁密钥提示.
 */
static void print_debug_info(void)
{
    generate_challenge(current_challenge, sizeof(current_challenge));

    printf("\n");
    printf("╔════════════════════════════════════════╗\n");
    printf("║             DEBUG MODE                 ║\n");
    printf("╠════════════════════════════════════════╣\n");
    printf("║                                        ║\n");
    printf("║  Challenge Code:                       ║\n");
    printf("║  %s             ║\n", current_challenge);
    printf("║                                        ║\n");
    printf("╠════════════════════════════════════════╣\n");
    printf("║  Fixed Key: 123456                     ║\n");
    printf("║                                        ║\n");
    printf("║  usages:                               ║\n");
    printf("║  Enter '123456' to unlock shell        ║\n");
    printf("║                                        ║\n");
    printf("╚════════════════════════════════════════╝\n");
    printf("\n");
    printf("Enter key to unlock: ");
    fflush(stdout);
}

/* ==================== 白名单命令处理模块 ==================== */

/** @fn static int is_allowed_command(const char *cmd)
 *  @brief 检查命令是否在白名单中
 *  @param[in] cmd 待检查的命令字符串.
 *  @return 1=允许执行, 0=禁止执行.
 */
static int is_allowed_command(const char *cmd)
{
    char trimmed[MAX_INPUT_LEN];
    int i;
    int j;
    char *p;

    /* 去除前导空格 */
    i = 0;
    while (cmd[i] == ' ' || cmd[i] == '\t') {
        i++;
    }

    /* 复制到 trimmed(提取第一个词) */
    j = 0;
    while (cmd[i] && cmd[i] != ' ' && cmd[i] != '\t'
           && cmd[i] != '\n' && j < MAX_INPUT_LEN - 1) {
        trimmed[j++] = cmd[i++];
    }
    trimmed[j] = '\0';

    /* 转换为小写比较 */
    for (p = trimmed; *p; p++) {
        *p = tolower(*p);
    }

    /* 白名单命令匹配 */
    if (strcmp(trimmed, "dmesg") == 0) {
        return 1;
    }
    if (strcmp(trimmed, "ps") == 0) {
        return 1;
    }

    return 0;
}

/** @fn static int execute_allowed_command(const char *cmd)
 *  @brief 在子进程中执行白名单命令
 *  @param[in] cmd 要执行的命令.
 *  @return 命令退出码, -1表示失败.
 */
static int execute_allowed_command(const char *cmd)
{
    pid_t pid;
    int status;

    pid = fork();
    if (pid < 0) {
        perror("fork");
        return -1;
    }

    if (pid == 0) {
        /* 子进程: 执行命令 */
        execl("/bin/sh", "sh", "-c", cmd, NULL);
        exit(127); /* exec 失败 */
    }

    /* 父进程: 等待子进程完成 */
    waitpid(pid, &status, 0);

    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

/** @fn static void print_unsupported(void)
 *  @brief 显示"不支持命令"的提示信息.
 */
static void print_unsupported(void)
{
    printf("[PSH] Command not supported in locked mode.\n");
    printf("[PSH] Available commands: dmesg, ps, debug\n\n");
    fflush(stdout);
}

/* ==================== 主循环模式模块 ==================== */

enum PSH_MODE {
    MODE_LOCKED,     /* 锁定模式: 只允许白名单命令 */
    MODE_UNLOCKING   /* 解锁模式: 等待密钥输入 */
};

/** @fn static void run_portal_shell(void)
 *  @brief 门限 Shell 主循环, 在锁定模式下运行并拦截所有命令输入.
 */
static void run_portal_shell(void)
{
    char input[MAX_INPUT_LEN];
    enum PSH_MODE mode = MODE_LOCKED;

    /* 显示启动横幅 */
    printf("\n");
    printf("╔════════════════════════════════════════╗\n");
    printf("║         Portal Shell v2.0              ║\n");
    printf("╠════════════════════════════════════════╣\n");
    printf("║  System is LOCKED                      ║\n");
    printf("║                                        ║\n");
    printf("║  Available commands:                   ║\n");
    printf("║  - dmesg   View kernel log             ║\n");
    printf("║  - ps      Show process list           ║\n");
    printf("║  - debug   Get unlock code             ║\n");
    printf("║                                        ║\n");
    printf("╚════════════════════════════════════════╝\n\n");

    /* 主循环 */
    while (!authenticated && !feof(stdin)) {
        if (mode == MODE_LOCKED) {
            printf("locked> ");
        } else {
            printf("key> ");
        }
        fflush(stdout);

        if (fgets(input, sizeof(input), stdin) == NULL) {
            break;
        }

        /* 去除换行符 */
        input[strcspn(input, "\r\n")] = '\0';

        if (mode == MODE_LOCKED) {
            /* 跳过空行 */
            if (input[0] == '\0') {
                continue;
            }

            /* 检查特殊命令: debug / unlock */
            if (strcasecmp(input, "debug") == 0
                || strcasecmp(input, "unlock") == 0) {
                print_debug_info();
                mode = MODE_UNLOCKING;
                continue;
            }

            /* 检查白名单命令 */
            if (is_allowed_command(input)) {
                execute_allowed_command(input);
                continue;
            }

            /* 其他命令都不支持 */
            print_unsupported();

        } else { /* MODE_UNLOCKING */
            /* 空输入: 取消解锁, 回到锁定模式 */
            if (input[0] == '\0') {
                printf("\n[PSH] Cancelled. Returning to locked mode.\n\n");
                mode = MODE_LOCKED;
            } else if (verify_key(input)) {
                /* 密钥正确, 解锁成功 */
                printf("\n[PSH] Access Granted! Unlocking shell...\n\n");
                authenticated = 1;
                break;
            } else {
                /* 密钥错误 */
                printf("\n[PSH] Invalid key! Returning to locked mode.\n\n");
                mode = MODE_LOCKED;
            }
        }
    } /* end of main loop */
}

/* ==================== Shell 启动模块 ==================== */

/** @fn static void launch_shell(void)
 *  @brief 替换当前进程为真正的交互式 shell(不返回).
 */
static void launch_shell(void)
{
    const char *shell = getenv("SHELL") ?: DEFAULT_SHELL;
    char *argv[2];

    argv[0] = (char *)shell;
    argv[1] = NULL;

    /* 设置环境变量标识 */
    setenv("PSH_AUTH", "1", 1);

    /* 替换当前进程为真正 shell (不返回) */
    execvp(shell, argv);

    perror("psh: execvp failed");
    exit(1);
}

/* ==================== 信号处理模块 ==================== */

/** @fn static void signal_handler(int sig)
 *  @brief 信号处理函数, 忽略中断信号防止绕过门禁.
 *  @param[in] sig 信号编号.
 */
static void signal_handler(int sig)
{
    switch (sig) {
    case SIGINT:
    case SIGTSTP:
        break; /* 忽略中断和挂起信号 */
    case SIGTERM:
        _exit(0); /* 终止信号直接退出 */
        break;
    default:
        break;
    }
}

/** @fn static void setup_signals(void)
 *  @brief 注册信号处理器.
 */
static void setup_signals(void)
{
    struct sigaction sa;

    sa.sa_handler = signal_handler;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTSTP, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
}

/* ==================== 日志记录模块 ==================== */

/** @fn static void log_event(const char *event)
 *  @brief 将事件记录到日志文件
 *  @param[in] event 事件描述字符串.
 */
static void log_event(const char *event)
{
    FILE *f;
    time_t now;
    char tbuf[64];
    const char *user;

    f = fopen("/var/log/psh.log", "a");
    if (!f) {
        return;
    }

    now = time(NULL);
    strftime(tbuf, sizeof(tbuf), "%F %T", localtime(&now));
    user = getenv("USER") ?: "?";

    fprintf(f, "[%s] [PID=%d] [%s] user=%s\n",
            tbuf, getpid(), event, user);
    fclose(f);
}

/* ==================== 主入口 ==================== */

/** @fn static void usage(const char *prog)
 *  @brief 打印使用帮助信息.
 *  @param[in] prog 程序名称.
 */
static void usage(const char *prog)
{
    printf("Usage: %s [options]\n"
           "Options:\n"
           "  -h, --help    Help\n"
           "  -v, --version Version\n"
           "Portal Shell v2.0 - Terminal door security system\n",
           prog);
}

/** @fn int main(int argc, char *argv[])
 *  @brief 程序主入口.
 *  @param argc 参数个数.
 *  @param argv 参数数组.
 *  @return 0=成功, 非0=失败.
 */
int main(int argc, char *argv[])
{
    int i;

    /* 参数解析 */
    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-h") == 0
            || strcmp(argv[i], "--help") == 0) {
            usage(argv[0]);
            return 0;
        }
        if (strcmp(argv[i], "-v") == 0
            || strcmp(argv[i], "--version") == 0) {
            printf("psh version 2.0.0\n");
            return 0;
        }
    }

    /* 检查是否为终端设备 */
    if (!isatty(STDIN_FILENO)) {
        fprintf(stderr, "psh: not a terminal\n");
        return 1;
    }

    setup_signals();
    log_event("START");

    /* 进入门禁主循环 */
    run_portal_shell();

    if (authenticated) {
        log_event("AUTH_OK");
        launch_shell(); /* 不返回 */
    }

    log_event("EXIT_FAIL");
    return 1;
}
