# psh v2.0 Makefile

CC      = arm-linux-gnueabihf-gcc
CFLAGS  = -Wall -Wextra -O2 -D_GNU_SOURCE

.PHONY: all clean install uninstall test help

all: psh bg-demo
	@echo "Build OK: psh bg-demo"

psh: psh.c
	$(CC) $(CFLAGS) -o $@ $<

bg-demo: bg-demo.c
	$(CC) $(CFLAGS) -o $@ $<

test:
	@echo "=== Test psh ==="
	@./psh --version || echo "(not built yet)"
	@echo ""

clean:
	rm -f psh bg-demo

install: all
	install -m 0755 psh    /bin/psh
	install -m 0755 bg-demo /usr/local/bin/bg-demo
	@echo "Installed: /bin/psh /usr/local/bin/bg-demo"
	@echo ""
	@echo "Config: add to /etc/inittab:"
	@echo "  ::respawn:-/bin/psh"

uninstall:
	rm -f /bin/psh

help:
	@echo "Targets: all clean install uninstall test help"
