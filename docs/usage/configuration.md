# 配置

## 配置文件

按优先级选择一个 YAML 文件，不合并多个来源：

1. --config /absolute/path/config.yaml
2. REMOTE_FS_MCP_CONFIG
3. ~/.remote-fs-mcp/config.yaml

找不到选定文件即启动失败。支持 YAML 1.2 单文档，拒绝重复键、别名、自定义标签和未知字段；不会自动加载 .env 或执行 shell/通用环境变量插值。配置修改后重启 MCP。

示例：[最小配置](../../examples/config.yaml)、[多服务器和资源预算](../../examples/config.advanced.yaml)。

## 服务器与目录

| 字段 | 规则或默认值 |
| --- | --- |
| version | 整数 1 |
| servers[].id | 全局唯一；1–64 个字母、数字、下划线或短横线 |
| connection.host | 主机名、IP 或 SSH 别名；不接受 URL、user@host 或内嵌端口 |
| connection.username | 显式认证必填；auto 可从 SSH User 取得 |
| connection.port | 1–65535，默认 22 |
| connection.auth | 默认 {type: auto} |
| connection.knownHostsFile | 默认 ~/.ssh/known_hosts，必须存在且可解析 |
| mounts[].id | 所属服务器内唯一，格式与 serverId 相同 |
| mounts[].path | 规范的 POSIX 绝对目录；允许 /root 等路径，不能直接为 / |
| mounts[].permissions | 默认 [read]；可选 read、write、delete，不能显式为空或重复 |

一台服务器可授权多个目录，不限制为少数几个挂载。挂载覆盖全部子目录和普通文件，具体操作仍受 OS 权限和资源预算约束。目录必须存在；create_directory 创建挂载内的目录，不创建挂载外的祖先。不同服务器可复用 mountId。

父挂载的授权覆盖子树。为其子目录再配置一个较窄的挂载，并不能撤销父挂载已经授予的权限。需要隔离时，应调整父挂载范围并结合 OS 权限。

本地文件路径支持 ~；其他相对路径以 YAML 所在目录为基准。远端路径始终使用 POSIX 规则，不接受穿越、反斜杠或符号链接。工具只接受相对于挂载的路径。

## 三类权限

| 权限 | 包含的操作 |
| --- | --- |
| read | 列目录、属性、读取、tail、搜索、归档浏览/读取/tail |
| write | 创建、覆盖/追加、建目录、重命名/移动、解压目标写入 |
| delete | 删除文件、空目录及显式递归删除 |

默认只读，用户可以显式配置 [read, write] 或 [read, write, delete]。write 不隐含 read 或 delete；重命名/移动属于 write，不要求 delete。单独的 delete 不允许读取或修改正文。

跨挂载移动检查同一服务器源、目标的 write；不跨服务器移动。解压检查源 read 与目标 write。挂载根目录本身不能删除或移动，但其子树内的普通文件和目录可按权限操作。归档覆盖和文件覆盖都属于 write，需要相应工具显式指定覆盖。

## 认证

每种方式仅接受自身字段，不回退到其他凭据：

| type | 字段 | 行为 |
| --- | --- | --- |
| password | password 或 passwordEnv | 恰好一个；引用变量必须存在且非空 |
| private-key | privateKeyPath；可选 passphrase 或 passphraseEnv | 私钥通过本机文件引用，口令来源互斥 |
| agent | 无额外字段 | 使用 SSH_AUTH_SOCK 中已加载的身份 |
| auto | 无额外字段 | 有限读取本机 SSH 配置，先 Agent，再尝试声明的 IdentityFile |

密码/口令按原字符串使用，不 trim 或展开。数字密码要加引号。环境变量由启动 MCP 的进程提供，不必每次工具调用注入；stdio 不交互询问密码。

本机私有 YAML 可以保存明文密码，应放在仓库外并限制访问：POSIX 建议目录 0700、文件 0600；Windows 使用账户 ACL。环境变量也不提供加密或模型隔离。不要在聊天、日志或问题报告中附真实凭据。

## OpenSSH 基础兼容

只有 auto 读取当前用户 ~/.ssh/config，不读取系统配置或扫描私钥目录：

- 支持字面 Host 别名、Host * 默认块，以及 HostName、User、Port、IdentityFile、IdentityAgent。
- 普通值取第一个匹配值，IdentityFile 按顺序去重。YAML 显式 username/port 优先。
- IdentityFile 支持绝对路径、~/；IdentityAgent 支持端点、none 或字面 SSH_AUTH_SOCK。
- Include/Match 拒绝；适用块中的其他指令、复杂 token、通配或否定模式拒绝。

不支持 ProxyJump、ProxyCommand、证书、键盘交互或多轮 MFA，不运行 ssh -G。复杂配置可改为显式连接和认证。auto 会预校验声明的私钥；加密私钥请使用显式 private-key 提供口令，或先由用户加入 Agent，再使用 agent。

## 资源预算

security 整段可省略，所有数值为整数。1 MiB = 1048576 字节，1 GiB = 1073741824 字节。配置较低时，工具默认请求自动降低；显式超限参数拒绝。

| 字段 | 默认值 | 可配置范围 |
| --- | --- | --- |
| followSymlinks | false | 只能为 false |
| maxReadBytes | 4194304（4 MiB） | 1–16777216（16 MiB） |
| maxWriteBytes | 16777216（16 MiB） | 1–1073741824（1 GiB） |
| maxSearchResults | 1000 | 1–10000 |
| maxScanBytes | 268435456（256 MiB） | 1–8589934592（8 GiB） |
| maxSearchDepth | 16 | 0–256 |
| maxDirectoryEntries | 10000 | 1–1000000 |
| maxOperationEntries | 100000 | 1–10000000 |
| maxArchiveBytes | 134217728（128 MiB） | 1–1073741824（1 GiB） |
| maxExtractBytes | 268435456（256 MiB） | 1–2147483648（2 GiB） |
| maxLineBytes | 1048576（1 MiB） | 1–16777216（16 MiB） |
| connectionTimeoutMs | 10000 | 1000–300000，且不大于操作超时 |
| operationTimeoutMs | 60000 | 1000–3600000，包含排队、建连、校验与 I/O |
| maxConcurrentOperations | 4 | 1–64 |

- read_file 默认返回 1 MiB，可请求到 maxReadBytes，用 nextOffset 继续；文件总大小不受此值限制。tail 使用同一读取预算。
- 搜索的普通文件只受剩余总扫描预算限制，不受 maxReadBytes 限制。包括归档时还计入展开内容；超大单行按 maxLineBytes 处理并标记跳过。
- write_file 的上限是 UTF-8/base64 解码后的字节数；空正文允许。解压写入使用 maxExtractBytes，另有条目预算。
- 目录列表默认一页 200 项，可用 nextOffset 继续；搜索、递归移动/删除校验和归档有 maxOperationEntries 总条目预算，包含空文件或被跳过的条目。
- 归档输入受 maxArchiveBytes 限制，展开受 maxExtractBytes 限制。ZIP 浏览不展开正文；读取指定 ZIP 成员只展开该成员。gzip/tar 顺序解析需要处理展开数据，tar 预算包括归档头部。
- 修改操作不是跨文件事务。超时、取消或 I/O 故障可能已有部分效果，检查错误中的 meta.mayHaveChanged；不会自动重试或用删除来模拟不支持的原子替换。

内部固定限制保留于本地输入和协议开销：YAML/私钥 1 MiB、SSH 配置 256 KiB、known_hosts 4 MiB；路径 4096 UTF-8 字节；关键词与匹配上下文各 4096 字节；序列化响应 64 MiB，等待队列 64。没有额外的小型服务器/挂载数量或路径段数限制，整体配置仍受文件字节预算约束。

响应预算包括 JSON 转义、文本结果和结构化结果；客户端另有消息、上下文和调用超时限制，配置大预算不等于客户端一定能接收同样大的正文。截断与操作细节见[工具参考](../reference/tools.md)。
