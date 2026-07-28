# VTD Web Sidecar

`vtd-sidecar` 为 Lichtblick Web 提供一个受限的 HTTP 到 `vtd` CLI 适配层。它只允许调用
`list`、`detail`、`topics`、`url`、`slice-store`、`slice-get` 和 `trigger`，请求参数会按命令白名单
转换成 CLI 参数，并始终以 `--json` 模式执行。服务不会启用 shell，也不接受调用方传入 `--env`。
下载命令以及 `--out`、`--save`、`--foxglove`、`--download` 等落盘或 GUI 选项均未开放。

## 构建镜像

`VTD_DOWNLOAD_URL` 和 `VTD_SHA256` 是构建时必填参数。下载地址应为构建环境可访问的内网
Linux amd64 发布地址，SHA-256 必须取自可信的同一发布流程：

```bash
docker build \
  --build-arg VTD_DOWNLOAD_URL="https://intranet.example/vtd-linux-x86" \
  --build-arg VTD_SHA256="<可信的64位十六进制摘要>" \
  -t lichtblick-vtd-sidecar \
  vtd-sidecar/
```

镜像以 `node` 非 root 用户运行。若摘要不匹配，构建会在安装二进制前失败。

## 运行

```bash
docker run --rm \
  -p 127.0.0.1:8770:8770 \
  -e ALLOW_ORIGIN="http://localhost:8080" \
  -e AUTH_TOKEN="<随机长令牌>" \
  lichtblick-vtd-sidecar
```

建议仅监听环回地址、受控内网或置于带 TLS 和访问控制的反向代理后，不要直接暴露到公网。

健康检查：

```bash
curl http://localhost:8770/healthz
```

调用示例：

```bash
curl -X POST http://localhost:8770/vtd/list \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <随机长令牌>' \
  -d '{"botSn":"SN001","page":1,"pageSize":20}'

curl -X POST http://localhost:8770/vtd/slice-store \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <随机长令牌>' \
  -d '{"id":"1234","topics":["/imu","/odom"],"startNs":"1700000000000000000"}'
```

成功响应是 `vtd` stdout 的原始 JSON；错误统一为：

```json
{ "error": "bad-request" }
```

其他错误类别为 `timeout` 和 `upstream-error`。CLI 的 stderr、退出码和内部异常只写入
Sidecar 日志，不会返回给调用方；日志会遮蔽 Bearer 值、HTTP(S) URL 凭据及请求后缀和完整
`tos://` 存储位置。

## 环境变量

| 名称               | 默认值     | 说明                                                                   |
| ------------------ | ---------- | ---------------------------------------------------------------------- |
| `PORT`             | `8770`     | HTTP 监听端口                                                          |
| `ALLOW_ORIGIN`     | 空         | 空值不发送 CORS 响应头；跨域部署时配置为 Lichtblick Web 的确切 Origin  |
| `AUTH_TOKEN`       | 空         | 非空时，所有命令请求必须携带完全匹配的 `Authorization: Bearer <token>` |
| `MAX_OUTPUT_BYTES` | `10485760` | 单个 CLI 进程 stdout 与 stderr 的合计字节上限，必须是正整数            |

`ALLOW_ORIGIN=*` 会允许任意网站从浏览器读取 Sidecar 响应，不代表认证，也不能替代网络隔离或
`AUTH_TOKEN`；仅应在可信、隔离的开发网络中临时使用。生产环境应配置确切 Origin，同时启用
Bearer token 或由反向代理执行等价认证。启用 `AUTH_TOKEN` 时 CORS 预检响应会允许
`Authorization` 请求头；预检本身不要求 token，实际 `POST` 请求仍会校验。

服务固定限制为：请求体必须在 10 秒内读完且不超过 1 MB；最多同时读取 32 个请求体，只有完整
解析后才占用最多 8 个 CLI 并发槽。单命令 30 秒，终止顺序为 `SIGTERM`、5 秒后 `SIGKILL`、再等
5 秒；若仍无 `close`，请求会以 timeout 结束，并在脱敏日志中把该进程标记为泄漏。该进程的并发
槽会继续保留，避免继续接单后突破进程上限；只有迟到的 `close` 真正到达时才释放槽位。
页码不超过 10000、每页不超过 100、单字符串不超过 4096 字符、topics 不超过 200 个；时间和
纳秒字符串必须落在有符号 int64 范围内。

## Lichtblick Web 配置

在 Web 应用设置中把 `agent.vtdEndpoint` 配置为 Sidecar 的可访问地址，并把
`agent.vtdAuthToken` 配置成与 Sidecar `AUTH_TOKEN` 完全相同的值，例如：

```text
agent.vtdEndpoint = http://localhost:8770
agent.vtdAuthToken = <与 AUTH_TOKEN 相同的随机长令牌>
```

如果 Lichtblick Web 与 Sidecar 位于同一个 Docker Compose 网络中，应使用浏览器实际可访问的公开地址；
不要填写仅容器内部可解析的服务名。`HttpVtdClient` 会按以下契约请求：

```text
POST {agent.vtdEndpoint}/vtd/<command>
Content-Type: application/json
Authorization: Bearer <agent.vtdAuthToken>  # 配置 token 时

<IVtdClient 方法对应的 params JSON>
```

Sidecar 不负责代理 LLM，也不保存 API Key。

`HttpVtdClient` 会在设置 `agent.vtdAuthToken` 后发送上述 Bearer 头；未配置时不会发送
`Authorization`。不要把长期令牌写进公开的构建产物或共享配置。面向不可信浏览器的生产部署仍
建议使用同源、受控的后端代理注入短期凭据，并通过 TLS 访问，避免把 Sidecar token 暴露给页面
脚本或使用 HTTPS 页面直连 HTTP Sidecar。

## 测试

```bash
node --test vtd-sidecar/server.test.mjs
```
