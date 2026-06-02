#include <stdio.h>
#include <string.h>
#include "src/func_qrencode.h"
#include "src/func_base64.h"
int main(int argc, char **argv)
{
    const char *text;

    if (argc < 2) {
        text = "Hello, QR Code!";
    } else {
        text = argv[1];
    }

    /* ========== QR Code 打印 ========= */
    printf("Text: %s\n\n", text);
    func_qrencode_generate_and_print(text);
    func_base64_test();
    printf("\nDone.\n");
    return 0;
}
