# Lichtblick All-in-One 阿里云 ACR / ACK 部署手册

本目录把 `Dockerfile.allinone` 构建的 All-in-One 镜像（Web 静态站 + vtd-sidecar API 同源单镜像，端口 8080）发布到阿里云 ACR，并用原生 k8s YAML 部署到已有 ACK 集群。不使用 Helm/Kustomize，不改动仓库现有代码。

> **命令执行环境**：除特别说明外，下文命令默认在 `deploy/aliyun/` 目录下执行（先 `cd deploy/aliyun`）。脚本内部基于脚本位置的绝对路径（`SCRIPT_DIR`/`REPO_ROOT`）定位所有文件，从仓库根或其他目录调用（如 `deploy/aliyun/build-push.sh`、`deploy/aliyun/deploy.sh`）行为一致。

## 镜像与接口约定

- 基于 `node:22-slim`，`USER node`（UID=1000），端口 8080，启动命令 `node /app/server.mjs`（`Dockerfile.allinone`）。
- `GET /healthz` 免鉴权，仅证明 Node 进程存活，**不证明 vtd 可用**——真实验收见「验证」一节。
- `/vtd/*` 需要 `Authorization: Bearer $AUTH_TOKEN`，仅接受 POST + JSON（`vtd-sidecar/server.mjs:970`）。
- vtd 二进制在构建期由 `VTD_DOWNLOAD_URL` 下载并用 `VTD_SHA256` 校验（必须为 linux/amd64 版本，ACK 节点为 amd64 架构）。

## 1. 本机 kubectl 连接 ACK（kubeconfig）

1. 阿里云控制台 → 容器服务 ACK → 集群 → 「连接信息」，按网络环境下载**公网或内网** kubeconfig；
2. 保存为 `~/.kube/config`，或另存 `~/.kube/ack-config` 后二选一：
   - 合并多集群：`export KUBECONFIG=~/.kube/config:~/.kube/ack-config`；
   - 仅本次使用：`kubectl --kubeconfig ~/.kube/ack-config <cmd> ...`；
   - 无论哪种方式，`chmod 600` 保护 kubeconfig 文件；
3. `kubectl config get-contexts` 查看上下文 → `kubectl config use-context <ack-context>` → `kubectl get nodes` 验证连通；
4. 备选：`aliyun cs GET /k8s/<cluster-id>/user_config` 获取集群配置。

## 2. 部署前预检（先做，结果决定配置）

- **Ingress controller**：`kubectl get ingressclass`，确认集群实际安装的是 nginx / ALB / MSE，`k8s/ingress.yaml` 的 `ingressClassName` 与注解以此为准（文件内给 nginx 与 ALB 两个模板注释），不预设 nginx 一定存在。
- **镜像拉取凭据**：`kubectl get pods -n kube-system | grep acr-credential`，确认是否已装 `aliyun-acr-credential-helper`：
  - 已装 → `ACR_PULL_MODE=helper`，**不要**设置 `imagePullSecrets`（显式设置会使 helper 失效）；
  - 未装 → `ACR_PULL_MODE=secret`，需创建 `acr-pull-secret`（见「第 5 节 首次部署：命名空间与 Secret 创建」）。
- **网络连通**：确认 ACK 节点与 ACR 同地域/VPC 网络连通，优先用 ACR 的 `-vpc` 私网域名拉取（`ACR_PULL_REGISTRY`）。
- **网络插件（CNI）**：`kubectl get pods -n kube-system | grep -iE 'flannel|terway|cilium'`（或 `kubectl get nodes -o wide` 看容器运行时/网络）确认集群网络插件。Flannel 网络下 ALB 后端无法直连 Pod IP，Service 需改用 NodePort/LoadBalancer 类型（见 `k8s/ingress.yaml` ALB 模板注释，并相应调整 `k8s/service.yaml`）；Terway（直连 Pod ENI）才可用 ClusterIP 后端。
- **vtd 架构**：确认 `VTD_DOWNLOAD_URL` 指向 linux-amd64 版本，`VTD_SHA256` 与之匹配（构建自检会强制复核镜像内 UID=1000，无需单独执行）。

## 3. 环境变量配置（.env.deploy）

```bash
cp .env.deploy.example .env.deploy
# 编辑 .env.deploy，逐项填写：
#   ACR_PUSH_REGISTRY  本地公网推送域名（registry.cn-hangzhou.aliyuncs.com）
#   ACR_PULL_REGISTRY  ACK 节点拉取域名（优先 -vpc 私网域名；无私网时可与 push 相同）
#   ACR_NAMESPACE      已创建的 ACR 命名空间
#   IMAGE_NAME         默认 lichtblick-allinone
#   TAG                默认 git-<12位commit>-vtd-<VTD_SHA256前8位>
#   VTD_DOWNLOAD_URL   vtd linux-amd64 发布地址
#   VTD_SHA256         同一发布的 sha256
#   ACR_PULL_MODE      helper | secret（按预检结果）
#   K8S_NAMESPACE      部署目标命名空间（默认 lichtblick；必须符合 DNS-1123）
#   INGRESS_HOST       Ingress 真实域名（example.com 占位值会被 deploy.sh 拒绝）
#   INGRESS_CLASS      nginx | alb（按预检到的 Ingress controller 填写）
#   API_URL            可选构建参数：viz-server 客户端 API 地址，必须带 /lichtblick 前缀
#   DEFAULT_WORKSPACE  可选构建参数：构建期默认 workspace（URL > 设置 > 此默认值）
```

`.env.deploy` 与 `.last-image` 已加入 `.gitignore`，不会入库。

## 4. 构建并推送镜像

```bash
./build-push.sh
```

流程：`docker login` → `docker build --platform linux/amd64`（build-arg 显式传 `VTD_DOWNLOAD_URL` / `VTD_SHA256`；`API_URL` / `DEFAULT_WORKSPACE` **非空时才追加** `--build-arg`，不传则镜像行为不变）→ 构建自检（容器内 `vtd --version` 正常；`id -u` 必须为 `1000`，与 deployment 的 `runAsUser` 一致，否则终止）→ `docker push` → 从 push 结果（或 `docker inspect` 的 RepoDigests）取 `sha256:` digest → 输出 `DEPLOY_IMAGE_REF=<ACR_PULL_REGISTRY>/<ACR_NAMESPACE>/<IMAGE_NAME>@sha256:...` 写入 `deploy/aliyun/.last-image`（单行 digest 引用）。

按 digest 部署可彻底规避 tag 覆盖/不滚动问题。

## 5. 首次部署：命名空间与 Secret 创建（仅首次）

**顺序：1) `./deploy.sh --namespace-only` 创建 namespace → 2) 再创建 AUTH/TLS/可选 ACR Secret → 3) 最后 `./deploy.sh`**（Secret 必须先于 Deployment 存在；`deploy.sh` 也会幂等 apply namespace）。

```bash
# 0) 先把 .env.deploy 加载进当前 shell（保证 $K8S_NAMESPACE / $ACR_PULL_REGISTRY 等变量可用）
set -a; source .env.deploy; set +a

# 1) 先创建命名空间（k8s/namespace.yaml 含 NAMESPACE_PLACEHOLDER，不可直接 apply，
#    必须经 deploy.sh 渲染；以下命令会渲染 NAMESPACE_PLACEHOLDER 为 $K8S_NAMESPACE 后 apply）
./deploy.sh --namespace-only

# 2) AUTH_TOKEN Secret：必建。/vtd/* 的 Bearer 鉴权值，与客户端 token 配置保持一致。
#    生成并保存此值（「客户端 token 配置」「验证」需使用同一值，勿重新生成）：
export AUTH_TOKEN="$(openssl rand -hex 32)"
kubectl -n "$K8S_NAMESPACE" create secret generic lichtblick-secrets \
  --from-literal=AUTH_TOKEN="$AUTH_TOKEN"

# 3) TLS 证书 Secret：ingress.yaml 的 tls 段引用 lichtblick-tls，必须存在。
#    阿里云证书服务下发的证书：
kubectl -n "$K8S_NAMESPACE" create secret tls lichtblick-tls \
  --cert=/path/to/tls.crt \
  --key=/path/to/tls.key
#    若集群已有 cert-manager：改用 k8s/ingress.yaml 中的 cert-manager.io/cluster-issuer
#    注解自动签发——前提是 ClusterIssuer 已存在；签发后确认 Secret 已生成：
#    kubectl -n "$K8S_NAMESPACE" get secret lichtblick-tls

# 4) ACR 拉取 Secret：仅当 ACR_PULL_MODE=secret 时需要（集群未装
#    aliyun-acr-credential-helper）。--docker-server 必须用「拉取」域名
#    （$ACR_PULL_REGISTRY），用户名/密码为 ACR 账号或临时 token
#    （阿里云容器镜像服务 → 访问凭证）。
kubectl -n "$K8S_NAMESPACE" create secret docker-registry acr-pull-secret \
  --docker-server="$ACR_PULL_REGISTRY" \
  --docker-username=<ACR 用户名> \
  --docker-password=<ACR 密码或临时 token>
```

## 6. 部署到集群

```bash
./deploy.sh
# 或显式指定镜像：DEPLOY_IMAGE_REF=registry-vpc.xxx/ns/lichtblick-allinone@sha256:... ./deploy.sh
# 仅创建命名空间（首次部署第一步）：./deploy.sh --namespace-only
```

流程：读取 `.env.deploy`（`ACR_PULL_MODE` / `K8S_NAMESPACE`，默认 `lichtblick`，先做 DNS-1123 校验 `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`；`INGRESS_HOST` 非空且不含 example.com，`INGRESS_CLASS` ∈ {nginx, alb}）→ `sed` 渲染**全部 manifests 的 `NAMESPACE_PLACEHOLDER`**、deployment 的 `IMAGE_PLACEHOLDER` 为 digest 引用、按 `ACR_PULL_MODE` 渲染 `imagePullSecrets`（secret 模式替换占位符为 `imagePullSecrets: [{name: acr-pull-secret}]`，helper 模式删除占位符行）、按 `INGRESS_CLASS` 渲染 ingress 的 host/ingressClassName/注解块（alb 时含 listen-ports/ssl-redirect/healthcheck-method: GET）→ 渲染到临时目录，apply 前 grep 自检无残留 `NAMESPACE_PLACEHOLDER` / `IMAGE_PLACEHOLDER` / Ingress 占位符 → `kubectl apply -f`（namespace 先于 deployment/service/ingress，全部用渲染后的临时文件）→ `kubectl -n "$K8S_NAMESPACE" rollout status deploy/lichtblick`。首次与更新发布同一路径；**首次部署前先按「第 5 节」完成 namespace + Secret 创建**。

## 7. 设置云端默认 layout（可选但推荐）

打开页面默认呈现的四面板 layout（3D / Image / map / RosOut，2×2，见 `default-layout.json`）由 viz-server 管理端下发。命令由部署者执行（无鉴权接口），以下代码块可直接复制执行：

```bash
apiBase="https://vtd-viz.vitarobot.cc"
layoutId="vtd-default-4panel"
layoutName="VTD 默认视图"

# 1) 上传 layout。固定 layoutId 保证幂等：服务端按 (workspace, layoutId) upsert，
#    重复执行更新同一条，不产生重复布局。
response=$(curl -fsS -X POST "$apiBase/lichtblick/workspaces/default/layout" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg layoutId "$layoutId" --arg name "$layoutName" \
    --argjson data "$(cat default-layout.json)" \
    '{layoutId: $layoutId, name: $name, permission: "ORG_READ", data: $data}')")

# 2) 管理端数据库 ID 在响应内层（不在顶层），用 jq 提取：
layoutDbId=$(printf '%s' "$response" | jq -er '.data.layout.id')

# 3) 设为默认：
curl -fsS -X PUT "$apiBase/api/v1/layouts/$layoutDbId/default" \
  -H 'Content-Type: application/json' \
  -d '{"is_default": true}' >/dev/null

# 4) 确认下发：data 非空且 layoutId 匹配（若响应结构与下方路径不一致，按实际调整 jq）
curl -fsS "$apiBase/lichtblick/workspaces/default/default-layout" \
  | jq -e --arg layoutId "$layoutId" '.data | select(.layoutId == $layoutId) | (.data | length) > 0'
```

## 8. 客户端 token 配置（修复"浏览器拿不到 token 401"）

部署完成后二选一：

- **有 viz-server 管理端**：更新 workspace default-config 的 `agent.vtdEndpoint`（填 Ingress HTTPS 地址）与 `agent.vtdAuthToken`（与 Secret 一致），参照 `vtd-sidecar/README.md:142`；
- **否则**：在 Web 设置界面手动配置同源 endpoint 与 token（AppSetting `AGENT_VTD_ENDPOINT` / `AGENT_VTD_AUTH_TOKEN`）。

## 9. 验证

> `$AUTH_TOKEN` 必须与 Secret `lichtblick-secrets` 中的值一致：沿用「第 5 节」export 的值（同一终端）；新终端请用赋值形式从集群读取，**不要重新生成**（否则与 Secret 不一致会 401）：
> `export AUTH_TOKEN="$(kubectl -n "$K8S_NAMESPACE" get secret lichtblick-secrets -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d)"`（`$K8S_NAMESPACE` 来自 `.env.deploy`，先 `set -a; source .env.deploy; set +a`）

```bash
# 端口转发（终端 1）
kubectl -n "$K8S_NAMESPACE" port-forward svc/lichtblick 18080:80

# 终端 2
curl http://127.0.0.1:18080/healthz
# → {"status":"ok"}

# 真实验收（此步验证 vtd 子进程与后端连通，而非仅 healthz；/vtd/* 仅接受 POST+JSON）
curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"page":1,"pageSize":1}' \
  http://127.0.0.1:18080/vtd/list
# → 返回真实数据
```

配 DNS + TLS 后，浏览器走 Ingress 访问，完成客户端 token 配置，页面内实际发起一次 `/vtd` 请求成功。

## 10. 安全与限制说明

- `AUTH_TOKEN` 只保护 `/vtd/*`，**不保护静态 Web 页面**；公网暴露需另加访问控制（IP 白名单注解 / OIDC / 或仅内网 SLB）——执行时和使用方确认入口是内网还是公网。
- **TLS 必须配置**：`k8s/ingress.yaml` 的 `tls:` 段引用证书 Secret（阿里云证书服务下发的证书 `kubectl create secret tls`，或集群已有 cert-manager 则用 annotation 签发），并开启 HTTP→HTTPS 跳转注解。
- **ALB ingress 必带注解**（若 `INGRESS_CLASS=alb`）：deploy.sh 自动渲染 `alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'`、`alb.ingress.kubernetes.io/ssl-redirect: "true"`、`alb.ingress.kubernetes.io/healthcheck-method: GET`（sidecar 的 `/healthz` 仅接受 GET，非 GET 健康检查会误判）。使用前先在 AlbConfig 配置 HTTPS 443 listener（重定向前后的 80 与 443 监听都必须存在）；Flannel 网络下后端需 NodePort/LoadBalancer 类型 Service。
- **存量用户注意**：在设置里手动填过 viz-server URL / VTD endpoint/token 的用户，**本地设置值优先于构建默认值与 bootstrap 下发**；401 未消失时，清掉设置里的旧 token（`AGENT_VTD_AUTH_TOKEN` / `AUTH_TOKEN`）即可恢复。
- **viz-server 无鉴权现状**：viz-server 全部接口（/lichtblick 客户端 + /api/v1 管理端）当前无鉴权、CORS `*`，公网 ALB 下匿名可读 bootstrap 内 VTD token、可写 org layout/extension。建议尽快补齐访问控制（ALB IP 白名单 / SSO / Go 侧鉴权，另行排期）；在补齐前部署即延续该状态，由使用方确认接受。
- `replicas: 1` 为**保守初始值，非结论**：vtd 每次请求都新起 CLI 子进程（`vtd-sidecar/server.mjs:689`），slice-store→slice-get 跨进程语义待实测；执行阶段验证后再决定是否多副本（rollout/Pod 重建仍会丢容器内状态，需知悉）。
- `resources`（requests 100m/256Mi，limits 1000m/1Gi）为**初始值**：sidecar 默认允许 8 个 vtd 并发、每进程 10MiB 输出缓存（`vtd-sidecar/server.mjs:13`），上线后按 CPU throttling/RSS/OOM 监控调整。
- 多副本评估（可选）：两 Pod 下实测 slice-store→slice-get 是否跨 Pod 可用，决定 `replicas` 策略。
- **切换 layout 不打断已加载数据**（需求 7 的实现边界）：切换期间保留完整旧 layout（仅标记 loading），订阅集合相同则不重跑加载；新旧订阅集合确实不同时，BlockLoader 增量调整属正常行为。**不在本次范围**：浏览器刷新/深链导致本地 File 数据源丢失（Web 平台限制，File 无法从 URL 恢复）；拖拽「layout+数据文件同批」会重建数据源，属预期行为。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `build-push.sh` | 构建自检 + 推送 ACR + 写 `.last-image`（digest 引用；`API_URL`/`DEFAULT_WORKSPACE` 非空才传 build-arg） |
| `deploy.sh` | 渲染全部 manifests（`NAMESPACE_PLACEHOLDER`/`IMAGE_PLACEHOLDER`/imagePullSecrets）并 `kubectl apply` + rollout 等待；`--namespace-only` 仅建命名空间 |
| `k8s/namespace.yaml` | 命名空间（`metadata.name` 为 `NAMESPACE_PLACEHOLDER`，由 deploy.sh 渲染） |
| `k8s/deployment.yaml` | Deployment（`namespace`/`IMAGE_PLACEHOLDER`/`# IMAGE_PULL_SECRETS_PLACEHOLDER` 由 deploy.sh 渲染） |
| `k8s/service.yaml` | ClusterIP 80 → 8080（`namespace` 由 deploy.sh 渲染） |
| `k8s/ingress.yaml` | Ingress（`INGRESS_HOST`/`INGRESS_CLASS` 由 deploy.sh 渲染，nginx/ALB 注解块二选一，TLS 必须） |
| `default-layout.json` | 云端默认 layout（3D/Image/map/RosOut 2×2，用于「第 7 节 设置云端默认 layout」） |
| `.env.deploy.example` | 环境变量模板（复制为 `.env.deploy`） |
