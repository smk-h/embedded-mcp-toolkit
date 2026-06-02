#include <stdio.h>
#include <time.h>
#include <unistd.h>

int main(void)
{
    time_t now;
    struct tm *tm_info;
    char buf[32];
    int count = 0;

    /* 短暂延迟，等 psh 的启动横幅先打完 */
    sleep(1);

    while (1) {
        now = time(NULL);
        tm_info = localtime(&now);
        strftime(buf, sizeof(buf), "%H:%M:%S", tm_info);
        fprintf(stderr, "\r[bg-demo #%d] %s - background task is alive\n",
                ++count, buf);
        fflush(stderr);
        sleep(2);
    }
    return 0;
}
