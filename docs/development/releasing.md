# npm 发布

## 元数据

包名、版本、简介、许可证和仓库信息维护在 `package.json`。简介修改后运行 `npm run docs:sync`；README 开头会同步，`npm pack` 会检查一致性。npm 页面直接使用发布包内的 README，不另写一套介绍。

`publishConfig` 固定官方 registry 与 public 可见性。不要把个人 `.npmrc`、token、两步验证码或私有 YAML 放入仓库。npm 登录信息由 npm CLI 管理。

## 发布前

1. 使用官方 registry 确认登录身份和包名/版本状态：

   ```bash
   npm whoami --registry=https://registry.npmjs.org/
   npm view remote-fs-mcp version --registry=https://registry.npmjs.org/
   ```

   首次发布时，包名查询返回 E404 属于预期；其他认证、网络或权限错误需要先解决。

2. 安装锁定依赖并检查：

   ```bash
   npm ci
   npm test
   npm run lint
   npm audit
   ```

3. 在项目根目录读取版本，将包输出到仓库外并验收：

   ```bash
   release_dir=$(mktemp -d)
   release_version=$(node -p "require('./package.json').version")
   release_tarball="$release_dir/remote-fs-mcp-$release_version.tgz"
   npm pack --pack-destination "$release_dir"
   npm run test:package -- "$release_tarball"
   npm publish "$release_tarball" --dry-run --registry=https://registry.npmjs.org/
   ```

   检查包内容只包含源码、公共文档、示例与许可证。验收产物不提交到 Git。

## 发布与验证

账号开启两步验证后，发布同一份已验收 tarball：

```bash
npm publish "$release_tarball" --access public --registry=https://registry.npmjs.org/
```

按 npm CLI 的提示在浏览器或认证器完成验证，不把验证码保存到文件。首次公开发布不能只依赖 dry-run 判断成功；以 registry 查询和实际下载为准：

```bash
npm view "remote-fs-mcp@$release_version" version dist.integrity --registry=https://registry.npmjs.org/
npx --yes remote-fs-mcp --version
npm run test:package -- "remote-fs-mcp@$release_version"
```

以上命令在同一终端执行，版本取自 `package.json`。发布后比对远端 `dist.integrity` 与本地 tarball 的 SHA-512 SRI。同名版本不能覆盖重用；新版本需同步 `package.json`、锁文件和 `src/common/constants.js`，使用文档无需维护版本号。

npm 发布与 Git 推送是独立操作；发布命令不等于推送授权。Windows 等未验证的平台应继续明确标注。[npm 官方发布说明](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
