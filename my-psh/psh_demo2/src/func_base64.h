#ifndef FUNC_BASE64_H
#define FUNC_BASE64_H

#include <stddef.h>

/**
 * @brief 对数据进行 Base64 编码
 * @param input 待编码的原始数据
 * @param input_len 原始数据长度（字节数）
 * @param output 输出缓冲区，用于存放 Base64 字符串（含结尾 '\0'）
 * @param output_size 输出缓冲区大小（字节数）
 * @return 成功返回输出字符串的长度（不含 '\0'），失败返回 -1
 */
int func_base64_encode(const unsigned char *input, size_t input_len,
                       char *output, size_t output_size);

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
                       size_t *out_len);

/**
 * @brief Base64 编码/解码自测函数
 */
void func_base64_test(void);

#endif
