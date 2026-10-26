# MCP 客户端接入

准备 Node.js >= 22、npm 和[私有配置](configuration.md)，将示例中的配置路径替换为本机真实的绝对路径。

客户端格式以其官方文档为准。首次下载较慢或桌面环境找不到 npx 时，见[启动排查](troubleshooting.md#启动后一直等待或客户端启动失败)。修改配置或升级后重连 MCP，已运行的进程不会自动更新。

## Codex

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.remote-fs]
command = "npx"
args = ["--yes", "remote-fs-mcp", "--config", "/absolute/path/config.yaml"]
startup_timeout_sec = 120
tool_timeout_sec = 90
```

也可使用 CLI 注册：

```bash
codex mcp add remote-fs -- npx --yes remote-fs-mcp --config /absolute/path/config.yaml
```

CLI 注册后也需补上上述超时设置。用 `codex mcp get remote-fs` 查看配置，Codex 内用 `/mcp` 检查连接。

使用 agent 认证时，在该表中增加：

```toml
env_vars = ["SSH_AUTH_SOCK"]
```

passwordEnv/passphraseEnv 同样需传递对应变量。变量必须在启动客户端时可用；另一个终端的环境不会更新已启动的桌面进程。

[OpenAI 官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## Claude Code

```bash
claude mcp add --transport stdio --scope user remote-fs -- npx --yes remote-fs-mcp --config /absolute/path/config.yaml
claude mcp get remote-fs
```

在 Claude Code 内用 `/mcp` 检查连接。[官方文档](https://code.claude.com/docs/en/mcp)

## Claude Desktop

在客户端 MCP 配置中合并以下条目：

```json
{
  "mcpServers": {
    "remote-fs": {
      "command": "npx",
      "args": ["--yes", "remote-fs-mcp", "--config", "/absolute/path/config.yaml"]
    }
  }
}
```

通过 Settings → Developer → Edit Config 打开配置文件，保留其他已有服务器，保存后重启客户端。[本地服务器接入指南](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

## 验证与 Windows

让 Agent 先调用 `list_mounts` 查看授权，再列目录和读取文件。默认只读，修改类工具即使可见也会被拒绝；修改操作应在隔离测试目录验证。

Windows 本地路径使用 `C:/Users/your-name/...`，远端路径仍为 POSIX 格式。配置文件使用账户 ACL 控制访问。若客户端不能直接启动 npx，可改用 `command: "cmd"`，参数为 `["/c", "npx", "--yes", "remote-fs-mcp", "--config", "C:/Users/your-name/.remote-fs-mcp/config.yaml"]`。

Windows 尚未全面实机验收。遇到问题见[常见问题](troubleshooting.md)。
