#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "qrencode.h"
#include "func_qrencode.h"

#define MARGIN 2

/**
 * @brief 将字符串编码为二维码
 * @param text 待编码的字符串
 * @return 成功返回 QRcode 指针，失败返回 NULL
 */
QRcode *func_qrencode_generate(const char *text)
{
    QRcode *qrcode;

    if (text == NULL) {
        fprintf(stderr, "Input text is NULL\n");
        return NULL;
    }

    qrcode = QRcode_encodeString(text, 0, QR_ECLEVEL_L, QR_MODE_8, 1);
    if (qrcode == NULL) {
        fprintf(stderr, "Failed to encode QR code\n");
        return NULL;
    }

    return qrcode;
}

/**
 * @brief 将已生成的二维码打印到终端（UTF-8 块字符方式）
 * @param qrcode QRcode 指针
 * @return 0 成功，-1 失败
 */
int func_qrencode_print(QRcode *qrcode)
{
    int x, y;
    int realwidth;
    const char *empty  = " ";           /* 空格：上下都是黑色 */
    const char *lowhalf = "\342\226\204"; /* ▄ 下半块：上半白色、下半黑色 */
    const char *uphalf  = "\342\226\200"; /* ▀ 上半块：上半黑色、下半白色 */
    const char *full   = "\342\226\210"; /* █ 实心块：上下都是白色 */

    if (qrcode == NULL) {
        fprintf(stderr, "QRcode is NULL\n");
        return -1;
    }

    realwidth = qrcode->width + MARGIN * 2;

    /* 打印上边距（每两个 margin 行合并为一行） */
    for (y = 0; y < MARGIN / 2; y++) {
        for (x = 0; x < realwidth; x++)
            fputs(full, stdout);
        fputc('\n', stdout);
    }

    /* 打印数据：每两行合并为一行输出 */
    for (y = 0; y < qrcode->width; y += 2) {
        unsigned char *row1 = qrcode->data + y * qrcode->width;
        unsigned char *row2 = row1 + qrcode->width;
        int x;

        /* 左边距 */
        for (x = 0; x < MARGIN; x++)
            fputs(full, stdout);

        /* 数据区 */
        for (x = 0; x < qrcode->width; x++) {
            if (row1[x] & 1) {                    /* 当前行是黑色 */
                if (y < qrcode->width - 1 && row2[x] & 1)
                    fputs(empty, stdout);          /* 下一行也是黑色 -> 空格(显示黑色) */
                else
                    fputs(lowhalf, stdout);         /* 下一行是白色 -> 下半黑 */
            } else {                               /* 当前行是白色 */
                if (y < qrcode->width - 1 && row2[x] & 1)
                    fputs(uphalf, stdout);          /* 下一行是黑色 -> 上半黑 */
                else
                    fputs(full, stdout);            /* 下一行也是白色 -> 实心块(显示白色) */
            }
        }

        /* 右边距 */
        for (x = 0; x < MARGIN; x++)
            fputs(full, stdout);

        fputc('\n', stdout);
    }

    /* 打印下边距（每两个 margin 行合并为一行） */
    for (y = 0; y < MARGIN / 2; y++) {
        for (x = 0; x < realwidth; x++)
            fputs(full, stdout);
        fputc('\n', stdout);
    }

    return 0;
}

/**
 * @brief 生成二维码并直接打印（便捷函数）
 * @param text 待编码的字符串
 * @return 0 成功，-1 失败
 */
int func_qrencode_generate_and_print(const char *text)
{
    QRcode *qrcode;
    int ret;

    qrcode = func_qrencode_generate(text);
    if (qrcode == NULL) {
        return -1;
    }

    ret = func_qrencode_print(qrcode);
    QRcode_free(qrcode);
    return ret;
}

/* 简单的测试入口 */
#ifdef QRENCODE_TEST_MAIN
int main(int argc, char **argv)
{
    const char *text;

    if (argc < 2) {
        text = "Hello, QR Code!";
    } else {
        text = argv[1];
    }

    return func_qrencode_generate_and_print(text);
}
#endif
