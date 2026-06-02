#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "func_base64.h"

/* Base64 编码字符表 */
static const char base64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * @brief 计算 Base64 编码后所需的最小缓冲区大小（含结尾 '\0'）
 */
static size_t base64_encoded_len(size_t input_len)
{
    return ((input_len + 2) / 3) * 4 + 1;
}

/**
 * @brief 计算 Base64 解码后所需的最大缓冲区大小
 */
static size_t base64_decoded_len(size_t input_len)
{
    return (input_len / 4) * 3;
}

/**
 * @brief 根据 Base64 字符反向查找其 6 位值
 */
static int base64_char_value(unsigned char ch)
{
    if (ch >= 'A' && ch <= 'Z')
        return ch - 'A';
    if (ch >= 'a' && ch <= 'z')
        return ch - 'a' + 26;
    if (ch >= '0' && ch <= '9')
        return ch - '0' + 52;
    if (ch == '+')
        return 62;
    if (ch == '/')
        return 63;
    return -1; /* 非法字符 */
}

/**
 * @brief 对数据进行 Base64 编码
 * @param input 待编码的原始数据
 * @param input_len 原始数据长度（字节数）
 * @param output 输出缓冲区，用于存放 Base64 字符串（含结尾 '\0'）
 * @param output_size 输出缓冲区大小（字节数）
 * @return 成功返回输出字符串的长度（不含 '\0'），失败返回 -1
 */
int func_base64_encode(const unsigned char *input, size_t input_len,
                       char *output, size_t output_size)
{
    size_t i, j;
    size_t min_size;

    if (input == NULL || output == NULL) {
        fprintf(stderr, "func_base64_encode: input or output is NULL\n");
        return -1;
    }

    min_size = base64_encoded_len(input_len);
    if (output_size < min_size) {
        fprintf(stderr, "func_base64_encode: output buffer too small "
                        "(need %zu, got %zu)\n",
                min_size, output_size);
        return -1;
    }

    /*
     * 每 3 字节原始数据编为 4 字符；末尾不足 3 字节时用 '=' 填充。
     * 编码后长度 = ((input_len + 2) / 3) * 4，等号数量 = (3 - input_len % 3) % 3:
     *   input_len % 3 == 0  →  0 个 '='（如 "ABC" → "QUJD"）
     *   input_len % 3 == 2  →  1 个 '='（如 "AB"  → "QUI="）
     *   input_len % 3 == 1  →  2 个 '='（如 "A"   → "QQ=="）
     */
    for (i = 0, j = 0; i < input_len;) {
        size_t        group_start = i;
        unsigned int  octet_a     = input[i++];
        unsigned int  octet_b     = (i < input_len) ? input[i++] : 0;
        unsigned int  octet_c     = (i < input_len) ? input[i++] : 0;
        size_t        consumed    = i - group_start; /* 1, 2 或 3 */

        unsigned int triple = (octet_a << 16) | (octet_b << 8) | octet_c;

        output[j++] = base64_table[(triple >> 18) & 0x3F];
        output[j++] = base64_table[(triple >> 12) & 0x3F];
        output[j++] = (consumed == 1) ? '='
                      : base64_table[(triple >> 6) & 0x3F];
        output[j++] = (consumed <= 2) ? '='
                      : base64_table[triple & 0x3F];
    }

    output[j] = '\0';
    return (int)j;
}

/**
 * @brief 对 Base64 字符串进行解码
 * @param input Base64 编码的字符串
 * @param input_len 输入字符串长度
 * @param output 输出缓冲区，用于存放解码后的原始数据
 * @param output_size 输出缓冲区大小（字节数）
 * @param out_len 输出参数，实际解码出的数据长度（字节数）
 * @return 0 成功，-1 失败
 */
int func_base64_decode(const char *input, size_t input_len,
                       unsigned char *output, size_t output_size,
                       size_t *out_len)
{
    size_t i, j;
    size_t pad = 0;
    size_t total_input = input_len;

    if (input == NULL || output == NULL || out_len == NULL) {
        fprintf(stderr, "func_base64_decode: invalid argument (NULL)\n");
        return -1;
    }

    /* 输入长度必须是 4 的倍数 */
    if (input_len % 4 != 0) {
        fprintf(stderr, "func_base64_decode: invalid base64 input length\n");
        return -1;
    }

    /* 统计末尾的 '=' 填充符数量 */
    while (input_len > 0 && input[input_len - 1] == '=')
        pad++, input_len--;

    /* 检查输出缓冲区大小 */
    {
        size_t max_dec = base64_decoded_len(total_input);
        if (max_dec < pad)
            max_dec = 0;
        else
            max_dec -= pad;

        if (output_size < max_dec) {
            fprintf(stderr, "func_base64_decode: output buffer too small "
                            "(need %zu, got %zu)\n",
                    max_dec, output_size);
            return -1;
        }
    }

    /* 逐组解码，每组 4 字符输出 1~3 字节 */
    for (i = 0, j = 0; i < total_input;) {
        int sextet[4], k;
        unsigned int triple;

        for (k = 0; k < 4; k++) {
            if (input[i] == '=') {
                /* 填充符视为 0 比特 */
                sextet[k] = 0;
                i++;
            } else {
                sextet[k] = base64_char_value((unsigned char)input[i++]);
                if (sextet[k] < 0) {
                    fprintf(stderr, "func_base64_decode: invalid base64 "
                                    "character '0x%02X'\n",
                            (unsigned char)input[i - 1]);
                    return -1;
                }
            }
        }

        triple = (unsigned int)sextet[0] << 18
               | (unsigned int)sextet[1] << 12
               | (unsigned int)sextet[2] << 6
               | (unsigned int)sextet[3];

        output[j++] = (triple >> 16) & 0xFF;
        if (j < output_size)
            output[j++] = (triple >> 8) & 0xFF;
        if (j < output_size)
            output[j++] = triple & 0xFF;
    }

    /* 根据填充字符数修正实际输出长度 */
    j -= pad;

    *out_len = j;
    return 0;
}

/* ================================================================
 * 示例与自测
 * ================================================================ */

static void test_roundtrip(const char *label, const char *plaintext)
{
    char encoded[1024];
    unsigned char decoded[1024];
    size_t decoded_len;
    int ret;

    printf("--- %s ---\n", label);
    printf("  Original:  \"%s\"\n", plaintext);

    /* 编码 */
    ret = func_base64_encode((const unsigned char *)plaintext,
                             strlen(plaintext),
                             encoded, sizeof(encoded));
    if (ret < 0) {
        printf("  [FAIL] encode error\n");
        return;
    }
    printf("  Encoded:   \"%s\"  (len=%d)\n", encoded, ret);

    /* 解码 */
    ret = func_base64_decode(encoded, strlen(encoded),
                             decoded, sizeof(decoded),
                             &decoded_len);
    if (ret < 0) {
        printf("  [FAIL] decode error\n");
        return;
    }
    decoded[decoded_len] = '\0';
    printf("  Decoded:   \"%s\"  (len=%zu)\n", decoded, decoded_len);

    /* 验证 */
    if (strcmp(plaintext, (char *)decoded) == 0) {
        printf("  [OK] round-trip 一致\n\n");
    } else {
        printf("  [FAIL] round-trip 不一致\n\n");
    }
}

static void test_binary(void)
{
    unsigned char data[] = {0x00, 0x10, 0x83, 0x10, 0x51, 0x87,
                            0x20, 0x92, 0x8B, 0x30, 0xD3, 0x8F,
                            0x41, 0x14, 0x93, 0x55, 0x55, 0x6A};
    char encoded[256];
    unsigned char decoded[256];
    size_t decoded_len, i;
    int ret;

    printf("--- Binary Data ---\n");
    printf("  Original (%zu bytes): ", sizeof(data));
    for (i = 0; i < sizeof(data); i++)
        printf("%02X ", data[i]);
    printf("\n");

    ret = func_base64_encode(data, sizeof(data), encoded, sizeof(encoded));
    if (ret < 0) {
        printf("  [FAIL] encode error\n");
        return;
    }
    printf("  Encoded: \"%s\"  (len=%d)\n", encoded, ret);

    ret = func_base64_decode(encoded, strlen(encoded),
                             decoded, sizeof(decoded),
                             &decoded_len);
    if (ret < 0) {
        printf("  [FAIL] decode error\n");
        return;
    }

    if (decoded_len == sizeof(data) &&
        memcmp(data, decoded, decoded_len) == 0) {
        printf("  [OK] 二进制数据 round-trip 一致\n\n");
    } else {
        printf("  [FAIL] 二进制数据 round-trip 不一致\n\n");
    }
}

void func_base64_test(void)
{
    printf("========== Base64 编码 / 解码 自测 ==========\n\n");

    test_roundtrip("1. 简单 ASCII", "Hello, World!");
    test_roundtrip("2. 空字符串", "");
    test_roundtrip("3. 单字符", "A");
    test_roundtrip("4. 两字符", "AB");
    test_roundtrip("5. 三字符", "ABC");
    test_roundtrip("6. 中文", "你好，世界！");
    test_binary();

    printf("全部测试完成。\n");
}
