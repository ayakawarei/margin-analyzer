# 第二阶段：手动发布 GHCR 镜像

此流程不连接 NAS，也不更改 8848 上的生产容器。未来测试端口为 8849。
在本 PR 合并且 main CI 通过后，从 Actions → Publish GHCR release →
Run workflow 选择 **main**。其他分支的发布任务会被跳过。每次运行固定使用
触发时的完整 commit SHA，重新执行可复用 CI（Python 3.12、Node 22、回归测试、
前端打包一致性、amd64 Docker 构建及 HTTP 冒烟检查）。只有 CI 全部成功，
才进入发布作业；发布作业也会检查实际将推送的镜像页面与健康 API。

## Actions 和包权限

- 仓库 Settings → Actions → General 应允许本工作流使用的 GitHub/docker actions。
- 默认 Workflow permissions 可保留只读；工作流按作业申请权限。
  CI 只有 `contents: read`，发布作业需要 `contents: write`（创建 tag、Release
  和附件）及 `packages: write`（GHCR 登录与推送）。组织策略须允许这些权限。
- 登录使用自动生成的 `GITHUB_TOKEN`，无需 PAT、NAS SSH 或生产密钥。
- 若同名 GHCR 包已存在，确认包 Settings → Manage Actions access 中本仓库具有
  写入权限；OCI source 标签关联此仓库，revision 标签记录提交 SHA。
- 新 GHCR 包通常为 private。需要匿名 NAS 拉取时，在包 Settings → Change
  package visibility 手动设为 public，并确认你希望公开镜像内容。工作流不会
  自动更改可见性。Private 包的拉取授权留待后续 NAS 部署阶段，本阶段不配置。

## 发布产物

镜像标签为 `ghcr.io/ayakawarei/margin-analyzer:<完整40位commit SHA>`，只构建
`linux/amd64`，不发布或使用 `latest`。推送后查询 GHCR 的真实 manifest digest，
生成如下 `production.json`，并作为正式（非 draft、非 prerelease）GitHub Release
附件上传。Release tag 为 `release-<完整commit SHA>`，指向该提交。

```json
{
  "image": "ghcr.io/ayakawarei/margin-analyzer@sha256:<实际64位digest>",
  "commit": "<完整40位commit SHA>",
  "platform": "linux/amd64"
}
```

从仓库 Releases 下载对应版本的附件。未来部署应使用 `image` 的 digest 引用，
不以可变 tag 或“最新 Release”为生产版本依据。本阶段不发布任何部署配置或
自动更新 NAS。健康 API 仅验证本地 HTTP 服务，不代表实时市场数据已验证。

## 重试和部分失败

发布作业串行执行，不取消正在发布的运行。同一 commit 的镜像若已存在，先
拉取其 digest 并重新冒烟验证，随后复用它，绝不因基础镜像或依赖更新而覆盖
SHA 标签。已有正式 Release 的附件必须与 registry digest、commit、platform
完全一致，才视为成功重试；不覆盖既有 Release 或附件。

镜像推送后创建 Release 失败，可重跑并复用镜像。如果 Release 已创建但附件
上传失败，或 tag、附件、镜像不一致，流程会明确失败：管理员须检查运行日志、
registry digest 和 Release 状态，修复/移除不完整 Release 后再重试，不要随意
覆盖正式版本。不得删除或改写已供生产使用的 SHA 镜像及 manifest。

本地可运行 `python -m unittest -v test_release.py` 验证发布顺序、main 限制和
重试行为。这是离线模拟；实际 `GITHUB_TOKEN` 权限、GHCR 推送、GitHub Release
及附件上传必须在 main 合并后的手动 Actions 运行中验证。
