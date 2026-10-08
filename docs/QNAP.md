# QNAP TS-253B：第一阶段开发与 CI

目标为 Intel Celeron J3455 / linux/amd64、8GB RAM、Container Station 3。
镜像使用 Python 3.12 slim，无 Node 或浏览器运行时依赖；Node 仅用于 CI 回归测试。
服务以 UID/GID 10001 非 root 用户运行，镜像内监听 `0.0.0.0:8848`。
直接执行 Python 时仍默认监听 `127.0.0.1`；可用 `MARGIN_BIND_HOST` 覆盖。

在开发机或 Container Station 的构建环境手动构建：

```bash
docker build --platform linux/amd64 -t margin-analyzer:local .
```

开发验证使用未来测试端口 8849：

```bash
docker run -d --name margin-analyzer-test \
  -p 127.0.0.1:8849:8848 margin-analyzer:local
curl --fail http://127.0.0.1:8849/api/health
docker stop margin-analyzer-test
docker rm margin-analyzer-test
```

生产端口规划为宿主机 `8848` → 容器 `8848`。本阶段不启动或更改生产服务。
Container Station 可手动导入/构建镜像并配置端口；局域网访问时选择 NAS 的
局域网地址作为宿主机绑定地址。服务没有认证，请使用受控局域网并限制端口访问。

缓存路径保持 `/app/.cache`；需要持久化时挂载专用卷或目录到此路径，确保
UID/GID 10001 可写。镜像不包含已有市场数据、虚拟环境或凭证。
健康检查只验证本地 HTTP 服务；实时数据仍需 JPX，以及浏览器到行情源公共代理的网络访问。

CI 在 PR、main 推送及手动触发时执行：Python 3.12、Node 22、六个现有 JS
回归套件、两个 Python 缓存/刷新套件及监听地址测试；先检查已提交 HTML，
再运行 `build.py`，检查生成结果与提交文件一致。独立 Docker 作业构建
linux/amd64 镜像，并通过宿主机 8849 检查页面与健康 API。

`test_parse.py` 的固定 PDF 夹具未随仓库分发，因此不作为 CI 必过项；
`verify_ui.py` 依赖 Playwright 浏览器与实时外部行情，保留为手动验收。
本配置不包含 NAS SSH 凭证、特权容器、镜像发布或自动部署。
