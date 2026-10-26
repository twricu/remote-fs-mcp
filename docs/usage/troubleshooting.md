# 常见问题

## 启动后一直等待，或客户端启动失败

stdio 服务没有交互式终端，手动启动后等待请求是正常行为；实际操作在 MCP 客户端中让 Agent 调用工具。`npx --yes remote-fs-mcp --version` 或 `--help` 可以检查包是否能运行，但不会验证远端连接。

首次下载较慢时，先运行 `--help` 预热，再按[客户端接入](clients.md)设置启动超时。桌面客户端的 PATH 可能与终端不同；使用 Node.js 22+ 同目录的 npx 绝对路径，并确保该 MCP 进程的 PATH 优先包含这个 Node 目录。仅修改 npx 路径不保证子进程使用正确的 Node 版本。调整后重连 MCP 或重启客户端。

## 首次连接提示主机密钥不可信

先从服务器管理员等独立可信渠道取得主机公钥指纹，再登记到所选 known_hosts。使用本机 OpenSSH 时，可将下面的账号、主机和端口替换为实际值：

```bash
sftp -o StrictHostKeyChecking=ask -P 22 deploy@192.0.2.10
```

仅在显示的指纹与可信来源一致时确认，按自己的认证方式登录后输入 `quit` 退出。MCP 默认读取 `~/.ssh/known_hosts`，也可配置 `knownHostsFile`。主机换钥时同样先核验，不跳过检查；`ssh-keyscan` 只能收集公钥，不能证明身份。[OpenSSH sftp 文档](https://man.openbsd.org/sftp)

## 原生 SSH 免登录，MCP 却认证失败

原生 ssh 可能直接读取默认私钥、使用密钥链或执行复杂配置；agent 模式只使用 `SSH_AUTH_SOCK` 中已经加载的身份。端点存在不代表 Agent 中有密钥。

确认实际使用的认证来源。可以显式引用现有 `privateKeyPath`，或由用户先将身份加入 Agent。不要为了适配 auto 而降低主机校验、导出私钥正文或改动服务器认证配置。

## 错误码

| 错误码 | 检查方向 |
| --- | --- |
| `CONFIG_INVALID` | YAML、受控字段位置、互斥认证来源、本地文件或环境变量；不要回显完整配置排查 |
| `INVALID_ARGUMENT` | 工具参数、字符边界、数值与字节上限 |
| `SERVER_NOT_FOUND` / `MOUNT_NOT_FOUND` | 使用 `list_mounts` 返回的 ID |
| `AUTH_FAILED` | 账号、私钥与口令、Agent 身份；不支持交互或 MFA |
| `HOST_KEY_REJECTED` | 可信指纹、解析后的主机名/端口、所选 known_hosts 中的换钥或撤销记录 |
| `PERMISSION_DENIED` | 挂载的 read/write/delete 与远端 OS 权限；write 不隐含 delete，服务端只读 SFTP 也会拒绝修改 |
| `PATH_OUT_OF_SCOPE` / `SYMLINK_DENIED` | 规范相对路径，以及从远端根到目标的任意链接段 |
| `NOT_FOUND` | 目标不存在或读取过程中已被移走 |
| `NOT_REGULAR_FILE` / `NOT_DIRECTORY` | 目标类型与所需操作不符，特殊文件不受支持 |
| `UNSUPPORTED_CONTENT` | 所读范围包含 NUL 或无效 UTF-8 |
| `TIMEOUT` / `LIMIT_EXCEEDED` | 缩小范围、检查队列或在合法范围内调整限额 |
| `CANCELLED` | 客户端已取消或服务器正在关闭 |
| `REMOTE_ERROR` | SSH/SFTP 不可用、断线或无法安全映射的错误；不会回退到远端命令 |
| `ALREADY_EXISTS` / `NOT_EMPTY` | 默认不覆盖已有目标、非递归不删除非空目录；按意图显式设置 overwrite/recursive |
| `UNSUPPORTED_OPERATION` | 服务端不支持原子覆盖重命名等扩展；不会先删目标再重试 |
| `INVALID_ARCHIVE` / `UNSUPPORTED_ARCHIVE` | 归档格式、路径、类型、CRC/结构完整性或不支持的加密/压缩方式 |

## 搜索没有结果

先检查起始目录、maxDepth、大小写选项、`meta.truncated`、reasons 和跳过计数。maxDepth=0 只搜索该目录的直接子文件；如果日志在子目录中，应修改搜索起点或深度。

普通文件扫描由 maxScanBytes 控制（默认合计 256 MiB），不受读取响应上限 maxReadBytes 限制。扫描被截断、长行被跳过或文件不可读时，空结果不能解释为完整目录没有匹配。压缩日志可设置 includeArchives=true，或用 read_archive 浏览/读取/tail；超出单归档预算、损坏或不支持的归档会跳过并标记不完整。read_file 的 nextOffset 可继续读取，查看大日志末尾可用 tail_file；search_files 本身不提供分页或索引。

## 修改操作失败

先查看 meta.mayHaveChanged。为 true 时，文件可能已创建、截短、部分写入、移动或删除，解压/递归删除也可能只完成了一部分；核查目标后再恢复，不直接重放请求。文件覆盖、移动与解压需要显式意图，默认不覆盖；删除目录默认不递归。跨文件系统移动受服务端 rename 能力限制。

## 提交问题

提供 Node/客户端版本、固定错误码，以及只含示例地址和占位符的最小配置。不要附密码、口令、私钥、完整个人配置或业务日志。安全问题见[安全报告](../../SECURITY.md)。
