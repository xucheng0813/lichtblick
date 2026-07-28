# SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
# SPDX-License-Identifier: MPL-2.0

FROM node:22-slim

ARG VTD_DOWNLOAD_URL
ARG VTD_SHA256

# VTD_DOWNLOAD_URL 应指向可从构建环境访问的内网 vtd-linux-x86 发布地址；
# VTD_SHA256 必须由同一发布流程提供，禁止用未经校验的二进制构建镜像。
RUN test -n "${VTD_DOWNLOAD_URL}" \
    && test -n "${VTD_SHA256}" \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "${VTD_DOWNLOAD_URL}" -o /usr/local/bin/vtd \
    && echo "${VTD_SHA256}  /usr/local/bin/vtd" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/vtd \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node server.mjs /app/server.mjs

USER node
EXPOSE 8770

CMD ["node", "/app/server.mjs"]
