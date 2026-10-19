# Sidereal 双人协作约定

## 第一次使用

1. 安装 Git、VS Code，并使用各自 GitHub 账号登录 VS Code。
2. GitHub 仓库所有者通过仓库 **Settings → Collaborators** 邀请另一位开发者；对方接受邀请。
3. 两人在 VS Code 中依次选择 **命令面板 → Git: Clone**，粘贴仓库 HTTPS 地址，选择本地文件夹并打开。
4. 通过 VS Code 的 **Source Control（源代码管理）** 面板查看改动、暂存、提交和同步。

## 每一轮（终端写法，也可在 VS Code 界面完成）

```bash
# 先切回并更新主分支
git switch main
git pull --ff-only

# 新建自己的功能分支（分支名按任务变化）
git switch -c feat/law-categories

# 修改、保存文件；检查再提交
git status
git diff
git add work/next-zone/src/law-categories.js
git commit -m "feat: add initial law subject categories"
git push -u origin feat/law-categories
```

之后在 GitHub 上发起 Pull Request，让另一位开发者检查再合并。不同人应使用**各自的 GitHub 账号**，不要共享访问令牌或密码。直接往 `main` 推送不是推荐的合作方式。

## 每个开发阶段的完成条件

每个开发阶段的计划都必须把以下流程列为最后一步：验证功能并检查差异，只提交该阶段涉及的文件，推送功能分支后创建面向 `main` 的 Pull Request；审查代码、自动检查和未解决意见，修正问题并重新验证，适用检查通过且审查意见处理完毕后合并，再将本地 `main` 同步到合并结果。

只有上述流程全部完成，才可将该开发阶段标记为完成。仅写完代码、通过本地测试、推送分支或创建 PR 均不算阶段完成；等待检查、审查修正或合并时，应明确报告阶段尚未完成。不能把同一账号的自查说成另一位开发者的批准，也不能绕过仓库的保护规则。

接口、备份恢复与账号密码管理回归检查无需安装依赖：`node --test work/content-studio/test/api.test.cjs work/content-studio/test/backup.test.cjs work/content-studio/test/password.test.cjs work/content-studio/test/recovery.test.cjs work/content-studio/test/hosted.test.cjs`。GitHub 的 Content Studio 工作流会在 Node.js 22.21.0 和 22 分支的维护版本上执行同一检查，并验证反向代理示例语法。浏览器交互仍需按阶段验证。不得提交 `work/content-studio/data/`、`.cache/`、真实资料、附件、密码、恢复码或密钥；合并源码不等于部署网站。

## Content Studio 联网测试配置

此配置仅准备独立 Content Studio 的小范围联网测试。默认仍在 `http://127.0.0.1:4173` 本机运行；主站及 Cloudflare 部署不在本阶段范围。联网前需要确认独立服务器、域名和资料使用范围，并在真实 HTTPS 环境验证账户、附件、备份与恢复；本机通过不代表公网部署完成。实际联网运行时使用已更新的 Node.js 22 维护版本。

先在目标服务器的模块目录中，以本机模式启动 `node server.cjs <模块绝对路径> 4173 <独立数据目录>`，通过本机浏览器或 SSH 本地端口转发访问，**由使用者手动创建首个账户**。保留这个独立数据目录，停止本机服务后，再用相同路径启动联网测试。不要将真实本机数据库上传来初始化，也不要在命令行写账户密码。空数据库在联网模式下会拒绝启动。

联网模式只增加环境变量 `STUDIO_PUBLIC_ORIGIN=https://你的实际域名`（无末尾斜线、路径或查询；非默认 HTTPS 端口须明确填写）。Linux shell 启动示例：

```bash
STUDIO_PUBLIC_ORIGIN=https://studio.example.test node /absolute/path/content-studio/server.cjs /absolute/path/content-studio 4173 /absolute/path/studio-data
```

`studio.example.test` 是占位域名，执行前替换。Node 服务仍只监听 `127.0.0.1`；同一服务器上的 HTTPS 反向代理接收对外访问。参考 `work/content-studio/Caddyfile.example`，使域名与环境变量完全一致，并保留浏览器原始 Host；不要把 Host 改为后端地址。验证实际 Caddy 配置用 `caddy validate --config /path/to/Caddyfile --adapter caddyfile`，验证成功后仍需单独安排域名解析、证书及实际服务启用。证书和服务配置不得提交到本仓库。

应用依据固定来源检查 Host/Origin 并启用 Secure Cookie，不信任 `X-Forwarded-Host` 或 `X-Forwarded-Proto`。代理只转发至 Node 白名单服务，**不要用文件服务器暴露项目根目录或数据目录**。停止进程后备份整个独立数据目录，可保留账户及全部资料；页面导出的是单份资料备份，不包含账号和恢复码。需要恢复服务数据时先停止服务、保留现有目录，再由操作者选择备份，不能自动覆盖。

当前认证限流是全服务共享的 30 次/分钟，适合小范围测试；公开面向大量用户前还需按实际代理、流量和存储容量调整防滥用策略。停用联网测试时停止代理及该实例；用同一数据目录取消 `STUDIO_PUBLIC_ORIGIN` 后可恢复本机模式，账户与资料保留。

## 安全与资料

- 不提交 `.env`、API Key、密码、真实加密密钥、个人数据与私人笔记。
- 不直接把法考教材、考研辅导资料或其他未经授权的受版权保护内容上传仓库。
- `vault/`、部署产物与本地依赖会被 `.gitignore` 排除；此前已经被 Git 跟踪的文件不受忽略规则影响，需要单独检查。
- 这个压缩包缺少在线站点的完整素材。需要部署前，应由原作者提供完整、获授权的资源并单独管理，不要提交进源码仓库。
- 先保留 Cloudflare 线上站点，功能未通过验证前不要覆盖部署。

## 出现冲突

不要执行 `git push --force` 或 `git reset --hard` 来消除协作冲突。先保留本地改动，再一起查看冲突的文件和具体代码。
