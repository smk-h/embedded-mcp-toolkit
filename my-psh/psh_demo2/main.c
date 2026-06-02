#include <stdio.h>
#include "src/func_qrencode.h"

int main(int argc, char **argv)
{
    const char *text;

    if (argc < 2) {
        text = "Hello, QR Code!";
    } else {
        text = argv[1];
    }

    printf("Text: %s\n\n", text);
    func_qrencode_generate_and_print(text);
    return 0;
}
