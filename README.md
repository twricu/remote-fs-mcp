# remote-fs-mcp

Mount-scoped SSH/SFTP filesystem MCP server with configurable read, write and delete permissions

本地通过 SSH/SFTP 操作授权远程目录。一台服务器可配置多个目录，支持密码、私钥和 SSH Agent 认证。需要 Node.js >= 22 和 npm，使用 stdio 传输。

## 快速开始

检查运行环境和 npm 包：

```bash
node --version
npx --yes remote-fs-mcp --version
```

创建本机私有配置 `~/.remote-fs-mcp/config.yaml`，填写主机、账号、认证信息和授权目录：

```yaml
version: 1
servers:
  - id: reports-host
    connection:
      host: 192.0.2.10
      username: deploy
      auth:
        type: password
        password: "REPLACE_WITH_SSH_PASSWORD"
    mounts:
      - id: reports
        path: /srv/reports
```

主机必须已有可信的 `~/.ssh/known_hosts` 记录，首次连接见[主机密钥登记](docs/usage/troubleshooting.md#首次连接提示主机密钥不可信)。真实配置保存在仓库外；POSIX 建议目录权限为 `0700`、文件为 `0600`。认证方式、默认值和目录规则见[配置](docs/usage/configuration.md)。

启动命令（将配置路径替换为本机真实的绝对路径）：

```bash
npx --yes remote-fs-mcp --config /absolute/path/config.yaml
```

由 MCP 客户端自动启动；手动运行会等待请求。无需克隆或全局安装。也可以让 Agent 根据上述四类信息生成配置并注册，密码可在本机补填。

客户端示例：[Codex](docs/usage/clients.md#codex)、[Claude Code](docs/usage/clients.md#claude-code)、[Claude Desktop](docs/usage/clients.md#claude-desktop)。

接入后可以直接对 Agent 说（将 ID 换成自己的配置）：

> 使用 remote-fs MCP 列出授权目录，在 reports-host/reports 中搜索 ERROR，包含压缩日志，再读取命中的文件。

## 工具

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `list_mounts` | 离线列出授权挂载 | 无 |
| `list_directory` / `stat_file` | 分页列目录、查看属性 | read |
| `read_file` / `tail_file` | 分段读取文本、查看末尾 | read |
| `search_files` | 按关键词和文件名模式搜索，可包含压缩日志 | read |
| `read_archive` | 查看、读取或 tail gzip/tar/tar.gz/zip 内容 | read |
| `write_file` | 创建、覆盖或追加文件 | write |
| `create_directory` / `move_path` | 创建目录、重命名或移动 | write |
| `delete_path` | 删除文件或目录，可显式递归 | delete |
| `extract_archive` | 将归档解压到授权目录 | 源 read、目标 write |

默认只读。修改需配置 `permissions: [read, write]`，删除需另外加入 `delete`。文件工具使用 `serverId + mountId + 相对路径`；参数、资源预算和截断规则见[工具参考](docs/reference/tools.md)。

## 安全边界

严格校验 SSH 主机密钥，拒绝路径穿越、符号链接、特殊文件和不安全归档条目。操作均使用封装的文件 API，不提供任意远程命令。修改失败可能已有部分效果，请检查 `meta.mayHaveChanged` 后再决定下一步。

**MCP 路径策略不能代替远端 OS 隔离。** 同一 Agent 若能直接使用 root SSH 凭据，仍可绕过 MCP。路径检查也不能彻底消除 TOCTOU 竞态；严格隔离需要受限账户和 SFTP chroot。私有配置不应提交到 Git，远端文件内容应视为不可信数据。

## 文档与开发

- [文档索引](docs/README.md)：配置、客户端、安全、架构与设计取舍。
- [参与开发](CONTRIBUTING.md)：测试、检查与打包。
- [安全报告](SECURITY.md)
- [MIT 许可证](LICENSE)
