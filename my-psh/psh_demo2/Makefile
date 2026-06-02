# =====================================================
# Makefile for psh_demo2
# =====================================================

CC      := gcc
CFLAGS  := -Wall -O2
LDFLAGS :=

PROJ_ROOT   := $(shell pwd)
LIB_DIR     := $(PROJ_ROOT)/libs/libqrencode-4.1.1
INSTALL_DIR := $(LIB_DIR)/_install

LIB_INC := -I$(INSTALL_DIR)/include -I$(LIB_DIR)
LIB_LIB := -L$(INSTALL_DIR)/lib -lqrencode

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
