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

接口、备份恢复与账号密码管理回归检查使用 Node.js 22.21.0，无需安装依赖：`node --test work/content-studio/test/api.test.cjs work/content-studio/test/backup.test.cjs work/content-studio/test/password.test.cjs work/content-studio/test/recovery.test.cjs`。GitHub 的 Content Studio 工作流会在相关 PR 和合并到 `main` 后执行同一检查。浏览器交互仍需按阶段验证。不得提交 `work/content-studio/data/`、`.cache/`、真实资料、附件、密码、恢复码或密钥；合并源码不等于部署网站。

## 安全与资料

- 不提交 `.env`、API Key、密码、真实加密密钥、个人数据与私人笔记。
- 不直接把法考教材、考研辅导资料或其他未经授权的受版权保护内容上传仓库。
- `vault/`、部署产物与本地依赖会被 `.gitignore` 排除；此前已经被 Git 跟踪的文件不受忽略规则影响，需要单独检查。
- 这个压缩包缺少在线站点的完整素材。需要部署前，应由原作者提供完整、获授权的资源并单独管理，不要提交进源码仓库。
- 先保留 Cloudflare 线上站点，功能未通过验证前不要覆盖部署。

## 出现冲突

不要执行 `git push --force` 或 `git reset --hard` 来消除协作冲突。先保留本地改动，再一起查看冲突的文件和具体代码。
