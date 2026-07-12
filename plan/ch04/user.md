# 我的初步想法

ssh相关的mcp工具目前还不支持文件的传入，有的时候我还要传输成果物，有些成果物还比较大，可能上百M，可以封装 SFTP：嵌入式 MCP 的 SSH 传输层用的是 ssh2 库，它原生支持 sftp 子系统（client.sftp() → createReadStream/createWriteStream）。加一个 upload / download 工具。
