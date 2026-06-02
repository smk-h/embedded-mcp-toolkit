#ifndef FUNC_QRENCODE_H
#define FUNC_QRENCODE_H

#include "qrencode.h"

QRcode *func_qrencode_generate(const char *text);
int func_qrencode_print(QRcode *qrcode);
int func_qrencode_generate_and_print(const char *text);

#endif
