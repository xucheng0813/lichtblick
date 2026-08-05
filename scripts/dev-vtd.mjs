// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// One-command local VTD development environment:
// 1. Detect the `vtd` CLI (well-known paths, then PATH via `vtd --version`).
// 2. If missing, install it from VTD_INSTALL_URL (internal mirror) and re-check.
// 3. Start vtd-sidecar/server.mjs as a child process with ALLOW_ORIGIN defaulting to the web dev server.
// 4. Forward SIGINT/SIGTERM to the sidecar.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_INSTALL_URL = "http://10.100.10.2:8082/install/vtd-cli.sh";
export const DEFAULT_ALLOW_ORIGIN = "http://localhost:8080";
export const SIDECAR_HEALTH_URL = "http://localhost:8770/healthz";
export const SIDECAR_SETTINGS_HINT = "在应用设置里把 VTD 服务地址填 http://localhost:8770";
export const MANUAL_INSTALL_HINT = `未检测到 vtd，自动安装失败。请手动安装后重试：
  curl -fsSL --proto '=http,https' --proto-redir '=http,https' -o /tmp/vtd-cli-install.sh ${DEFAULT_INSTALL_URL}
下载成功后再运行：bash /tmp/vtd-cli-install.sh
或将安装脚本地址通过环境变量 VTD_INSTALL_URL 指定后再次运行 yarn vtd:dev。`;

const SIDECAR_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "vtd-sidecar",
  "server.mjs",
);

export function candidateVtdPaths(homeDir) {
  return [
    path.join(homeDir, ".local", "bin", "vtd"),
    "/usr/local/bin/vtd",
    "/opt/homebrew/bin/vtd",
  ];
}

/**
 * Locates the `vtd` CLI. Well-known paths are checked first; if none exist, `vtd` is probed
 * through PATH by running `vtd --version`. Returns the binary path, or undefined when vtd is
 * not installed.
 */
export function findVtdBinary({
  homeDir = homedir(),
  accessSyncImpl = accessSync,
  execFileSyncImpl = execFileSync,
} = {}) {
  for (const candidate of candidateVtdPaths(homeDir)) {
    try {
      accessSyncImpl(candidate, constants.X_OK);
      execFileSyncImpl(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next known location, then PATH.
    }
  }
  try {
    execFileSyncImpl("vtd", ["--version"], { stdio: "ignore" });
    return "vtd";
  } catch {
    return undefined;
  }
}

export function parseInstallUrl(value) {
  if (/[&;\s]/u.test(value)) {
    throw new Error("VTD_INSTALL_URL contains forbidden characters");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VTD_INSTALL_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("VTD_INSTALL_URL must use the http: or https: protocol");
  }
  return parsed.href;
}

export function buildInstallCommands(vtdInstallUrl, installerPath) {
  const url = parseInstallUrl(vtdInstallUrl);
  return [
    {
      command: "curl",
      args: [
        "-fsSL",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        "--output",
        installerPath,
        url,
      ],
    },
    { command: "bash", args: [installerPath] },
  ];
}

/**
 * Runs the vtd installer with inherited stdio. Returns true on success, false otherwise.
 */
export function installVtd({
  vtdInstallUrl,
  spawnSyncImpl = spawnSync,
  mkdtempSyncImpl = mkdtempSync,
  rmSyncImpl = rmSync,
  tempDir = tmpdir(),
  log = console.log,
  onError = console.error,
} = {}) {
  let temporaryDirectory;
  try {
    const url = vtdInstallUrl ?? process.env.VTD_INSTALL_URL ?? DEFAULT_INSTALL_URL;
    const validatedUrl = parseInstallUrl(url);
    temporaryDirectory = mkdtempSyncImpl(path.join(tempDir, "lichtblick-vtd-install-"));
    const installerPath = path.join(temporaryDirectory, "install.sh");
    const [download, install] = buildInstallCommands(validatedUrl, installerPath);
    log(`未检测到 vtd CLI，从 ${validatedUrl} 下载安装脚本。`);

    const downloadResult = spawnSyncImpl(download.command, download.args, { stdio: "inherit" });
    if (downloadResult.status !== 0) {
      onError(`vtd 安装脚本下载失败（退出码 ${downloadResult.status ?? "未知"}）。`);
      return false;
    }
    const installResult = spawnSyncImpl(install.command, install.args, { stdio: "inherit" });
    if (installResult.status !== 0) {
      onError(`vtd 安装失败（退出码 ${installResult.status ?? "未知"}）。`);
      return false;
    }
    log("vtd 安装完成。");
    return true;
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (temporaryDirectory != undefined) {
      try {
        rmSyncImpl(temporaryDirectory, { force: true, recursive: true });
      } catch (error) {
        onError(
          `清理 vtd 安装临时目录失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

/**
 * Returns PATH with ~/.local/bin (where the installer drops the binary) prepended,
 * without duplicating entries.
 */
export function withLocalBinOnPath({ homeDir = homedir(), env = process.env } = {}) {
  const localBin = path.join(homeDir, ".local", "bin");
  const parts = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((part) => part !== "" && part !== localBin);
  return [localBin, ...parts].join(path.delimiter);
}

export function withVtdBinaryOnPath(vtdBinary, env = process.env) {
  if (!path.isAbsolute(vtdBinary)) {
    return env.PATH ?? "";
  }
  const binaryDirectory = path.dirname(vtdBinary);
  const parts = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((part) => part !== "" && part !== binaryDirectory);
  return [binaryDirectory, ...parts].join(path.delimiter);
}

export function resolveSidecarEnv(env = process.env, vtdBinary = "vtd") {
  return {
    ...env,
    ALLOW_ORIGIN: env.ALLOW_ORIGIN ?? DEFAULT_ALLOW_ORIGIN,
    PATH: withVtdBinaryOnPath(vtdBinary, env),
  };
}

export function startSidecar({
  spawnImpl = spawn,
  env = resolveSidecarEnv(),
  log = console.log,
} = {}) {
  log(`启动 VTD sidecar：node ${SIDECAR_ENTRY}`);
  log(`健康检查：curl ${SIDECAR_HEALTH_URL}`);
  log(SIDECAR_SETTINGS_HINT);
  log(`CORS ALLOW_ORIGIN：${env.ALLOW_ORIGIN}（可用环境变量 ALLOW_ORIGIN 覆盖）`);
  log("按 Ctrl-C 停止。");
  return spawnImpl(process.execPath, [SIDECAR_ENTRY], { env, stdio: "inherit" });
}

/**
 * Forwards SIGINT/SIGTERM to the child process. Returns a cleanup function.
 */
export function forwardSignals(child, signals = ["SIGINT", "SIGTERM"]) {
  const forward = (signal) => {
    child.kill(signal);
  };
  for (const signal of signals) {
    process.on(signal, forward);
  }
  return () => {
    for (const signal of signals) {
      process.removeListener(signal, forward);
    }
  };
}

export async function runVtdDev({
  findVtdBinaryImpl = findVtdBinary,
  installVtdImpl = installVtd,
  startSidecarImpl = startSidecar,
  prependLocalBinImpl = withLocalBinOnPath,
  forwardSignalsImpl = forwardSignals,
  log = console.log,
  onError = console.error,
} = {}) {
  let binary = findVtdBinaryImpl();
  if (binary == undefined) {
    log("未检测到 vtd CLI，尝试自动安装…");
    if (!installVtdImpl()) {
      onError(MANUAL_INSTALL_HINT);
      return 1;
    }
    process.env.PATH = prependLocalBinImpl();
    binary = findVtdBinaryImpl();
    if (binary == undefined) {
      onError(`安装完成后仍无法找到 vtd。${MANUAL_INSTALL_HINT}`);
      return 1;
    }
  }
  log(`vtd 已就绪：${binary}`);
  const child = startSidecarImpl({ env: resolveSidecarEnv(process.env, binary) });
  forwardSignalsImpl(child);
  return await new Promise((resolve) => {
    child.once("close", (code) => {
      resolve(code ?? 0);
    });
  });
}

if (process.argv[1] != undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const exitCode = await runVtdDev();
  process.exit(exitCode);
}
