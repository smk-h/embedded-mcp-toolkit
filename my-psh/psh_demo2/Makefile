# =====================================================
# Makefile for psh_demo2
# =====================================================

CC      := gcc
CFLAGS  := -Wall -O2
LDFLAGS :=

PROJ_ROOT   := $(shell pwd)
LIBS_DIR    := $(PROJ_ROOT)/libs

# ---- 头文件目录 ----
INC_DIRS :=
INC_DIRS += $(LIBS_DIR)/libqrencode-4.1.1/_install/include

# ---- 库文件目录 ----
LIB_DIRS :=
LIB_DIRS += $(LIBS_DIR)/libqrencode-4.1.1/_install/lib

# ---- 链接库 ----
LIBS :=
LIBS += qrencode
LIBS += pthread

# ---- 自动生成编译选项 ----
LIB_INC   := $(addprefix -I,$(INC_DIRS))
LIB_LIB   := $(addprefix -L,$(LIB_DIRS)) $(addprefix -l,$(LIBS))

TARGET := psh
SRCS   := $(wildcard *.c src/*.c)
OBJS   := $(SRCS:%.c=%.o)

.PHONY: all build clean run

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) $^ $(LIB_LIB) -o $@

%.o: %.c
	$(CC) $(CFLAGS) $(LIB_INC) -c $< -o $@

build: $(TARGET)

run: $(TARGET)
	./$(TARGET) "Hello, QR Code!"

clean:
	rm -f $(TARGET) $(OBJS)
