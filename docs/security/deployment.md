# 服务端受限 SFTP 部署示例（手动操作）

本说明是部署参考，本项目不会执行这些改动。请由服务器管理员在隔离测试环境验证，不要直接改现有生产目录权限或 SSH 服务配置。平台及 OpenSSH 版本可能影响具体指令，参考 [sshd_config 官方文档](https://man.openbsd.org/sshd_config)。

目标：专用账户 `mcp-reader`，只允许 SFTP、禁用转发，将服务器可见范围限制在独立 jail。示意配置如下：

```text
Match User mcp-reader
    ChrootDirectory /srv/sftp/mcp-reader
    ForceCommand internal-sftp -R
    DisableForwarding yes
    PermitTTY no
```

`ChrootDirectory` 及其祖先必须满足 OpenSSH 的所有者/写权限要求，通常由 root 拥有且不可由组/其他用户写入。不要把现有业务目录随意 chmod/chown 来凑要求；应为 jail 单独设计目录和必要的只读 bind mount/权限。

例如把授权资料放到 jail 内 `/reports`，MCP 中的 mount.path 就是 `/reports`，而不是服务端宿主路径 `/srv/sftp/mcp-reader/reports`。不要依赖 symlink 跨目录映射，本 MCP 会拒绝链接。

管理员验证清单：

1. 在独立配置或测试实例中运行 OpenSSH 配置语法检查，保留已有管理连接和恢复方式。
2. 确认专用用户无法取得 shell、执行命令、转发端口，且只看到 jail 内允许的资料。
3. 确认只读 SFTP 和 OS 权限均拒绝写入；正确配置 jail 所有者和祖先权限。
4. 独立核验服务器主机指纹，登记到本机已选 known_hosts 文件。
5. 使用测试账户核验 MCP 的正常读取、越界路径、链接及特殊文件拒绝。

`internal-sftp -R` 与 chroot 是服务器隔离措施；MCP 的路径检查仅作为附加层。若 Agent 同时保有另一套 root SSH 入口，仍可绕过该 MCP。

需要 write/delete 时，由管理员为专用账户启用可写 SFTP（不使用 -R），并在 jail 内规划可写子目录和 OS 权限；保留 chroot、禁用 Shell/转发以及祖先所有权要求。MCP 中配置 write/delete 不会越过服务端只读模式或 OS 拒绝，也不会自动修改 sshd 配置。不要为了可写而放宽 chroot 根目录的所有者/写权限。
