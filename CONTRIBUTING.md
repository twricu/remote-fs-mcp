# 参与开发

使用原生 JavaScript ESM。开发检查请使用 Node.js 22.13+（22.x）或 24+，以满足 ESLint 10 的运行要求；MCP 本身的运行要求仍为 Node.js >= 22。

```bash
npm ci
npm test
npm run lint
```

MCP stdio 检查可单独运行 `npm run test:stdio`。测试只使用本机回环和临时身份；覆盖与运行环境见[测试说明](docs/development/testing.md)。

## 修改代码

先阅读[架构](docs/development/architecture.md)与[设计决策](docs/development/decisions.md)。文件操作通过共享授权与路径入口，工具不能自行绕过权限、类型或资源限制。

新增或修改工具时覆盖正常、拒绝与关键边界行为；修复缺陷时补上能暴露该缺陷的用例。保留认证、主机密钥、路径穿越、链接、取消和预算相关的核心回归测试。

接口变化同步[工具参考](docs/reference/tools.md)，配置变化同步[配置文档](docs/usage/configuration.md)和示例。不要提交个人配置、密钥、密码、日志正文、机器专属验收报告或生成的 npm 包。

## 检查打包内容

```bash
npm pack --dry-run
```

需要本地安装包时，将产物输出到仓库外：

```bash
npm pack --pack-destination /absolute/path/to/output
```

npm 包通过 files 白名单包含源码、示例和公共文档，不包含测试夹具或开发者配置。发布前确认包名归属、版本、许可证与目标平台验证结果；发布和 Git 推送由维护者明确安排。

包简介以 `package.json.description` 为唯一来源，修改后运行 `npm run docs:sync` 同步 README 开头。打包时会检查两者一致。发布步骤与独立安装验收见[发布说明](docs/development/releasing.md)。

## 问题与安全报告

普通问题请提供最小复现与脱敏错误码，不附业务日志或凭据。安全问题参见 [SECURITY.md](SECURITY.md)。
