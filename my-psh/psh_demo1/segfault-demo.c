/*
 * segfault-demo.c - 演示 Segmentation Fault 的程序
 * 
 * 此程序故意触发段错误，用于测试调试器和错误处理机制。
 * 编译: make segfault-demo
 * 运行: ./segfault-demo
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 方法1: 解引用 NULL 指针 */
void method_null_pointer(void)
{
    printf("[方法1] 解引用 NULL 指针...\n");
    fflush(stdout);
    
    int *ptr = NULL;
    *ptr = 42;  /* Segmentation Fault! */
}

/* 方法2: 访问未分配的内存 */
void method_invalid_memory(void)
{
    printf("[方法2] 访问未分配的内存...\n");
    fflush(stdout);
    
    int *ptr = (int *)0xDEADBEEF;  /* 无效地址 */
    *ptr = 100;  /* Segmentation Fault! */
}

/* 方法3: 栈溢出（无限递归） */
void method_stack_overflow(int depth)
{
    if (depth % 1000 == 0) {
        printf("[方法3] 递归深度: %d\n", depth);
        fflush(stdout);
    }
    
    char buffer[1024];
    memset(buffer, 'A', sizeof(buffer));
    
    method_stack_overflow(depth + 1);  /* 无限递归导致栈溢出 */
}

/* 方法4: 写入只读内存 */
void method_write_rodata(void)
{
    printf("[方法4] 写入只读内存...\n");
    fflush(stdout);
    
    char *str = "Hello, World!";  /* 字符串字面量存储在只读段 */
    str[0] = 'h';  /* Segmentation Fault! */
}

int main(int argc, char *argv[])
{
    int choice = 1;
    
    printf("=== Segmentation Fault 演示程序 ===\n");
    printf("此程序将故意触发段错误\n\n");
    
    if (argc > 1) {
        choice = atoi(argv[1]);
    } else {
        printf("选择触发方式:\n");
        printf("  1 - 解引用 NULL 指针 (默认)\n");
        printf("  2 - 访问未分配的内存\n");
        printf("  3 - 栈溢出（无限递归）\n");
        printf("  4 - 写入只读内存\n");
        printf("\n使用: %s [1-4]\n\n", argv[0]);
    }
    
    printf("正在执行方法 %d...\n\n", choice);
    
    switch (choice) {
        case 1:
            method_null_pointer();
            break;
        case 2:
            method_invalid_memory();
            break;
        case 3:
            method_stack_overflow(0);
            break;
        case 4:
            method_write_rodata();
            break;
        default:
            printf("无效选择，使用默认方法 (NULL 指针)\n");
            method_null_pointer();
            break;
    }
    
    printf("如果你看到这行，说明段错误没有发生！\n");
    return 0;
}
