#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
# SPDX-License-Identifier: MPL-2.0
#
# 渲染 k8s manifests（NAMESPACE_PLACEHOLDER + 镜像 digest 引用 + imagePullSecrets）并部署到 ACK。
# 首次与更新发布走同一路径。
#
# 用法：
#   ./deploy.sh                        # 默认读取 $SCRIPT_DIR/.last-image（build-push.sh 写入）
#   DEPLOY_IMAGE_REF=... ./deploy.sh   # 显式指定部署镜像（须为 digest 引用）
#   ./deploy.sh --namespace-only       # 仅渲染并 apply namespace.yaml 后退出（首次部署第一步）
#
# 依赖：deploy/aliyun/.env.deploy（须含 ACR_PULL_MODE=helper|secret、K8S_NAMESPACE）；
#       本机 kubectl 已连接 ACK。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."

MODE="deploy"
if [ "${1:-}" = "--namespace-only" ]; then
  MODE="namespace-only"
elif [ "$#" -gt 0 ]; then
  echo "错误：未知参数 \"$1\"（仅支持 --namespace-only）。" >&2
  exit 1
fi

ENV_FILE="$SCRIPT_DIR/.env.deploy"
if [ ! -f "$ENV_FILE" ]; then
  echo "错误：缺少 ${ENV_FILE}（请先 cp .env.deploy.example .env.deploy 并填写）。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

K8S_NAMESPACE="${K8S_NAMESPACE:-lichtblick}"
# DNS-1123 标签校验：小写字母/数字/中划线，首尾必须为字母或数字。
if ! [[ "$K8S_NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "错误：K8S_NAMESPACE 不符合 DNS-1123（^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\$）：${K8S_NAMESPACE}" >&2
  exit 1
fi

echo "==> 目标命名空间（K8S_NAMESPACE）：$K8S_NAMESPACE"

# 渲染单个 manifest：替换 namespace: NAMESPACE_PLACEHOLDER 与 name: NAMESPACE_PLACEHOLDER
# （后者仅 namespace.yaml 的 metadata.name 使用），其余占位符由调用方追加的 sed 表达式处理。
render_manifest() {
  local src="$1"
  local dst="$2"
  shift 2
  sed -E \
    -e "s|^([[:space:]]*)namespace: NAMESPACE_PLACEHOLDER$|\1namespace: ${K8S_NAMESPACE}|" \
    -e "s|^([[:space:]]*)name: NAMESPACE_PLACEHOLDER$|\1name: ${K8S_NAMESPACE}|" \
    "$@" \
    "$src" > "$dst"
}

TMP_DIR="$(mktemp -d)"
# EXIT trap 保留原退出状态：避免清理命令成功时把失败路径（set -e / 校验失败）掩盖为 0。
trap 'status=$?; rm -rf "$TMP_DIR"; exit "$status"' EXIT

if [ "$MODE" = "namespace-only" ]; then
  render_manifest "$SCRIPT_DIR/k8s/namespace.yaml" "$TMP_DIR/namespace.yaml"
  if grep -q 'NAMESPACE_PLACEHOLDER' "$TMP_DIR/namespace.yaml"; then
    echo "错误：渲染后的 namespace.yaml 仍包含 NAMESPACE_PLACEHOLDER，渲染失败。" >&2
    exit 1
  fi
  echo "==> 应用 namespace：$TMP_DIR/namespace.yaml"
  kubectl apply -f "$TMP_DIR/namespace.yaml"
  echo "==> 命名空间已就绪。接下来创建 Secrets（-n \"$K8S_NAMESPACE\"，见 README），然后运行 ./deploy.sh。"
  exit 0
fi

if [ -z "${ACR_PULL_MODE:-}" ]; then
  echo "错误：.env.deploy 未设置 ACR_PULL_MODE（helper|secret）。" >&2
  exit 1
fi
if [ "$ACR_PULL_MODE" != "helper" ] && [ "$ACR_PULL_MODE" != "secret" ]; then
  echo "错误：ACR_PULL_MODE 必须是 helper 或 secret（当前：${ACR_PULL_MODE}）。" >&2
  exit 1
fi

DEPLOY_IMAGE_REF="${DEPLOY_IMAGE_REF:-}"
if [ -z "$DEPLOY_IMAGE_REF" ]; then
  LAST_IMAGE_FILE="$SCRIPT_DIR/.last-image"
  if [ ! -f "$LAST_IMAGE_FILE" ]; then
    echo "错误：缺少 ${LAST_IMAGE_FILE}（请先运行 ./build-push.sh，或用 DEPLOY_IMAGE_REF=... 显式指定）。" >&2
    exit 1
  fi
  DEPLOY_IMAGE_REF="$(cat "$LAST_IMAGE_FILE")"
fi

# Ingress 参数：INGRESS_HOST 必须为真实域名（example.com 占位值拒绝 apply）；
# INGRESS_CLASS 决定 ingress.yaml 渲染的 controller 与注解块。
if [ -z "${INGRESS_HOST:-}" ]; then
  echo "错误：.env.deploy 未设置 INGRESS_HOST（Ingress 真实域名，如 lichtblick.vitarobot.cc）。" >&2
  exit 1
fi
if [[ "$INGRESS_HOST" == *example.com* ]]; then
  echo "错误：INGRESS_HOST 含 example.com 占位域名，禁止 apply。请改为真实域名：$INGRESS_HOST" >&2
  exit 1
fi
INGRESS_CLASS="${INGRESS_CLASS:-nginx}"
if [ "$INGRESS_CLASS" != "nginx" ] && [ "$INGRESS_CLASS" != "alb" ]; then
  echo "错误：INGRESS_CLASS 必须是 nginx 或 alb（当前：${INGRESS_CLASS}）。" >&2
  exit 1
fi

# .last-image 内容规定为单行 digest 引用。整串按 OCI reference 允许字符严格校验
# （^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$），拒绝多行/CR 及 sed 特殊字符，避免注入 sed 渲染。
if ! [[ "$DEPLOY_IMAGE_REF" =~ ^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "错误：DEPLOY_IMAGE_REF 格式非法（应为单行 <registry>/<namespace>/<image>@sha256:<64位hex>）：$DEPLOY_IMAGE_REF" >&2
  exit 1
fi

echo "==> 部署镜像（digest 引用）：$DEPLOY_IMAGE_REF"
echo "==> 拉取模式（ACR_PULL_MODE）：$ACR_PULL_MODE"

# 全部 manifests 先渲染到临时目录（含 namespace.yaml），apply 前统一做占位符自检。
render_manifest "$SCRIPT_DIR/k8s/namespace.yaml" "$TMP_DIR/namespace.yaml"
if [ "$ACR_PULL_MODE" = "secret" ]; then
  render_manifest "$SCRIPT_DIR/k8s/deployment.yaml" "$TMP_DIR/deployment.yaml" \
    -e "s|^([[:space:]]*)image: IMAGE_PLACEHOLDER$|\1image: ${DEPLOY_IMAGE_REF}|" \
    -e "s|^([[:space:]]*)# IMAGE_PULL_SECRETS_PLACEHOLDER$|\1imagePullSecrets: [{name: acr-pull-secret}]|"
else
  render_manifest "$SCRIPT_DIR/k8s/deployment.yaml" "$TMP_DIR/deployment.yaml" \
    -e "s|^([[:space:]]*)image: IMAGE_PLACEHOLDER$|\1image: ${DEPLOY_IMAGE_REF}|" \
    -e "/^[[:space:]]*# IMAGE_PULL_SECRETS_PLACEHOLDER[[:space:]]*$/d"
fi
render_manifest "$SCRIPT_DIR/k8s/service.yaml" "$TMP_DIR/service.yaml"
if [ "$INGRESS_CLASS" = "alb" ]; then
  # ALB 模式：删除 nginx 注解块，取消注释 ALB 注解（含 healthcheck-method: GET）。
  render_manifest "$SCRIPT_DIR/k8s/ingress.yaml" "$TMP_DIR/ingress.yaml" \
    -e "s|INGRESS_HOST_PLACEHOLDER|${INGRESS_HOST}|g" \
    -e "s|^([[:space:]]*)ingressClassName: INGRESS_CLASS_PLACEHOLDER$|\1ingressClassName: alb|" \
    -e "/# BEGIN_NGINX_ANNOTATIONS/,/# END_NGINX_ANNOTATIONS/d" \
    -e "/^[[:space:]]*# BEGIN_ALB_ANNOTATIONS$/d" \
    -e "/^[[:space:]]*# END_ALB_ANNOTATIONS$/d" \
    -e 's|^([[:space:]]*)# (alb\.ingress\.kubernetes\.io/.*)$|\1\2|'
else
  # nginx 模式：删除 ALB 注解块。
  render_manifest "$SCRIPT_DIR/k8s/ingress.yaml" "$TMP_DIR/ingress.yaml" \
    -e "s|INGRESS_HOST_PLACEHOLDER|${INGRESS_HOST}|g" \
    -e "s|^([[:space:]]*)ingressClassName: INGRESS_CLASS_PLACEHOLDER$|\1ingressClassName: nginx|" \
    -e "/# BEGIN_ALB_ANNOTATIONS/,/# END_ALB_ANNOTATIONS/d" \
    -e "/^[[:space:]]*# BEGIN_NGINX_ANNOTATIONS$/d" \
    -e "/^[[:space:]]*# END_NGINX_ANNOTATIONS$/d"
fi

# 渲染结果自检（锚定 YAML 行，避免误匹配文件头部说明注释）。
for manifest in "$TMP_DIR"/*.yaml; do
  if grep -q 'NAMESPACE_PLACEHOLDER' "$manifest"; then
    echo "错误：渲染后的 $(basename "$manifest") 仍包含 NAMESPACE_PLACEHOLDER，渲染失败。" >&2
    exit 1
  fi
  if grep -qE 'INGRESS_HOST_PLACEHOLDER|INGRESS_CLASS_PLACEHOLDER' "$manifest"; then
    echo "错误：渲染后的 $(basename "$manifest") 仍包含 Ingress 占位符，渲染失败。" >&2
    exit 1
  fi
done
if grep -Eq '^[[:space:]]*image: IMAGE_PLACEHOLDER$' "$TMP_DIR/deployment.yaml"; then
  echo "错误：渲染后的 deployment 仍包含 image: IMAGE_PLACEHOLDER，渲染失败。" >&2
  exit 1
fi
if [ "$ACR_PULL_MODE" = "secret" ] && ! grep -q 'imagePullSecrets: \[{name: acr-pull-secret}\]' "$TMP_DIR/deployment.yaml"; then
  echo "错误：secret 模式下渲染结果缺少 imagePullSecrets 字段。" >&2
  exit 1
fi
if [ "$ACR_PULL_MODE" = "helper" ] && grep -Eq '^[[:space:]]*# IMAGE_PULL_SECRETS_PLACEHOLDER[[:space:]]*$' "$TMP_DIR/deployment.yaml"; then
  echo "错误：helper 模式下渲染结果仍包含 IMAGE_PULL_SECRETS_PLACEHOLDER 占位符行。" >&2
  exit 1
fi

echo "==> 渲染结果（namespace / image / imagePullSecrets / ingress）："
grep -nE '^  namespace: |^    name: |image: |imagePullSecrets:|ingressClassName: |- host: |alb\.ingress|nginx\.ingress' "$TMP_DIR"/*.yaml || true

echo "==> 应用 namespace（渲染）"
kubectl apply -f "$TMP_DIR/namespace.yaml"

echo "==> 应用 deployment（渲染）/ service / ingress（渲染）"
kubectl apply -f "$TMP_DIR/deployment.yaml" -f "$TMP_DIR/service.yaml" -f "$TMP_DIR/ingress.yaml"

echo "==> 等待 rollout 完成"
kubectl -n "$K8S_NAMESPACE" rollout status deploy/lichtblick

echo "==> 部署完成。"
