@echo off
REM ============================================================
REM MCP Server launcher (shared by local Claude and remote SSH)
REM
REM Purpose: pin the working directory and 5 environment variables
REM          so that whether started locally or via ssh from Linux,
REM          the node process always has the same env as a local
REM          Claude launch. Paths are relative to cwd, which is
REM          anchored to the project root by the cd /d below.
REM
REM Usage:
REM   - Local: double-click, or invoked by local .mcp.json
REM   - Remote: set as the ssh remote command in Linux .mcp.json
REM ============================================================

REM Anchor cwd to this script's project root (%~dp0 ends with \)
cd /d "%~dp0"

REM Environment variables (keep in sync with .mcp.json env block)
set DEVICE=board-b
set BOARD_CONFIG_PATH=./.embedded/configs/config.yaml
set LOG_SAVE=1
set LOG_DIR=./.embedded/log
set SAVE2FILE_PATH=./.embedded/log

REM Launch MCP server (stdio transport)
node bin\embedded-mcp-toolkit-cli.js
