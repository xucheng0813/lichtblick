#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
# SPDX-License-Identifier: MPL-2.0
#
# 构建并推送 Lichtblick All-in-One 镜像到阿里云 ACR，并把按 digest 的部署引用写入
# $SCRIPT_DIR/.last-image（供 deploy.sh 使用）。
#
# 用法：./build-push.sh
# 依赖：deploy/aliyun/.env.deploy（模板见 .env.deploy.example）；本机已登录 docker。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."

ENV_FILE="$SCRIPT_DIR/.env.deploy"
if [ ! -f "$ENV_FILE" ]; then
  echo "错误：缺少 ${ENV_FILE}（请先 cp .env.deploy.example .env.deploy 并填写）。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${ACR_PUSH_REGISTRY:?错误：.env.deploy 未设置 ACR_PUSH_REGISTRY（本地公网推送域名）}"
: "${ACR_PULL_REGISTRY:?错误：.env.deploy 未设置 ACR_PULL_REGISTRY（ACK 节点拉取域名）}"
: "${ACR_NAMESPACE:?错误：.env.deploy 未设置 ACR_NAMESPACE}"
: "${VTD_DOWNLOAD_URL:?错误：.env.deploy 未设置 VTD_DOWNLOAD_URL（须指向 linux/amd64 版本）}"
: "${VTD_SHA256:?错误：.env.deploy 未设置 VTD_SHA256}"

IMAGE_NAME="${IMAGE_NAME:-lichtblick-allinone}"
# 默认 tag 把 vtd 摘要纳入，避免同 SHA 重建产生同名不同内容的 tag。
TAG="${TAG:-git-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)-vtd-${VTD_SHA256:0:8}}"
PUSH_IMAGE_REF="$ACR_PUSH_REGISTRY/$ACR_NAMESPACE/$IMAGE_NAME:$TAG"

echo "==> 登录 ACR：$ACR_PUSH_REGISTRY"
# 已有凭证则跳过（交互式 login 在非 TTY 环境会失败）；未登录时才交互登录。
if grep -q "\"$ACR_PUSH_REGISTRY\"" "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then
  echo "    检测到已保存的登录凭证，跳过 docker login。"
else
  docker login "$ACR_PUSH_REGISTRY"
fi

echo "==> 构建镜像：$PUSH_IMAGE_REF"
BUILD_ARGS=(
  --platform linux/amd64
  -f "$REPO_ROOT/Dockerfile.allinone"
  --build-arg "VTD_DOWNLOAD_URL=$VTD_DOWNLOAD_URL"
  --build-arg "VTD_SHA256=$VTD_SHA256"
)
# 可选构建参数：非空才追加 --build-arg，不传则镜像行为不变。
if [ -n "${API_URL:-}" ]; then
  BUILD_ARGS+=(--build-arg "API_URL=$API_URL")
fi
if [ -n "${DEFAULT_WORKSPACE:-}" ]; then
  BUILD_ARGS+=(--build-arg "DEFAULT_WORKSPACE=$DEFAULT_WORKSPACE")
fi
docker build "${BUILD_ARGS[@]}" -t "$PUSH_IMAGE_REF" "$REPO_ROOT"

echo "==> 构建自检：vtd 版本"
docker run --rm --platform linux/amd64 --entrypoint /usr/local/bin/vtd "$PUSH_IMAGE_REF" --version

echo "==> 构建自检：容器用户 UID 必须为 1000（与 deployment.yaml 的 runAsUser: 1000 一致）"
UID_OUTPUT="$(docker run --rm --platform linux/amd64 --entrypoint id "$PUSH_IMAGE_REF" -u)"
echo "    id -u 输出：$UID_OUTPUT"
if [ "$UID_OUTPUT" != "1000" ]; then
  echo "错误：镜像内非 root 用户 UID 不是 1000（实际 '$UID_OUTPUT'），与 deployment 的 runAsUser 不一致，终止。" >&2
  exit 1
fi

echo "==> 推送镜像：$PUSH_IMAGE_REF"
if ! PUSH_OUTPUT="$(docker push "$PUSH_IMAGE_REF" 2>&1)"; then
  printf '%s\n' "$PUSH_OUTPUT" >&2
  exit 1
fi
printf '%s\n' "$PUSH_OUTPUT"
# 优先从 push 输出解析 digest，失败则回退 docker inspect（RepoDigests 首项）。
DIGEST="$(printf '%s\n' "$PUSH_OUTPUT" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -n 1)"
if [ -z "$DIGEST" ]; then
  DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$PUSH_IMAGE_REF" | sed -n 's/.*\(sha256:[0-9a-f]\{64\}\)$/\1/p')"
fi
if [ -z "$DIGEST" ]; then
  echo "错误：无法从 push 输出或 docker inspect 获取镜像 digest。" >&2
  exit 1
fi

# 按 digest 部署，彻底规避 tag 覆盖/不滚动问题；拉取域名用 ACR_PULL_REGISTRY。
DEPLOY_IMAGE_REF="$ACR_PULL_REGISTRY/$ACR_NAMESPACE/$IMAGE_NAME@$DIGEST"
printf '%s\n' "$DEPLOY_IMAGE_REF" > "$SCRIPT_DIR/.last-image"

echo "==> 完成。按 digest 的部署引用（已写入 $SCRIPT_DIR/.last-image）："
echo "    $DEPLOY_IMAGE_REF"
