// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import type { App, IpcMain, WebContents } from "electron";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import VtdCliService, {
  invalidateVtdExecutableCache,
  resolveVtdExecutable,
  VtdCliError,
} from "./VtdCliService";
import type {
  VtdInstallResult,
  VtdInvokeRequest,
  VtdInvokeResult,
  VtdStatus,
} from "../common/types";

const VTD_VERSION_TIMEOUT_MS = 5_000;
const VTD_INSTALL_OUTPUT_BYTES = 8 * 1024;
export const DEFAULT_VTD_INSTALL_URL = "http://10.100.10.2:8082/install/vtd-cli.sh";

type ProcessResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

type RegisterVtdIpcHandlersOptions = {
  app: Pick<App, "once" | "quit">;
  ipcMain: Pick<IpcMain, "handle">;
  service?: VtdCliService;
};

function errorResult(error: unknown): VtdInvokeResult {
  if (error instanceof VtdCliError) {
    return { code: error.code, message: error.message, ok: false };
  }
  return {
    code: "process",
    message: error instanceof Error ? error.message : "Unknown vtd CLI error",
    ok: false,
  };
}

function appendOutputTail(existing: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= VTD_INSTALL_OUTPUT_BYTES) {
    return chunk.subarray(chunk.byteLength - VTD_INSTALL_OUTPUT_BYTES);
  }
  const retained = Math.min(existing.byteLength, VTD_INSTALL_OUTPUT_BYTES - chunk.byteLength);
  const result = new Uint8Array(retained + chunk.byteLength);
  result.set(existing.subarray(existing.byteLength - retained));
  result.set(chunk, retained);
  return result;
}

function parseInstallUrl(value: string): string {
  if (/[&;\s]/u.test(value)) {
    throw new Error("VTD_INSTALL_URL contains forbidden characters");
  }
  let parsed: URL;
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

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs?: number,
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, { shell: false });
    } catch (error) {
      resolve({
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    let output: Uint8Array = new Uint8Array();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      output = appendOutputTail(output, Uint8Array.from(buffer));
    };
    const finish = (exitCode: number | null, outcome: "completed" | "timed-out"): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout != undefined) {
        clearTimeout(timeout);
      }
      resolve({
        exitCode,
        output: Buffer.from(output).toString("utf8").trim(),
        timedOut: outcome === "timed-out",
      });
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdout.once("error", (error) => {
      append(error.message);
      child.kill("SIGKILL");
      finish(null, "completed");
    });
    child.stderr.once("error", (error) => {
      append(error.message);
      child.kill("SIGKILL");
      finish(null, "completed");
    });
    child.once("error", (error) => {
      append(error.message);
      finish(null, "completed");
    });
    child.once("close", (code) => {
      finish(code, "completed");
    });

    if (timeoutMs != undefined) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null, "timed-out");
      }, timeoutMs);
      timeout.unref();
    }
  });
}

export async function getVtdStatus(): Promise<VtdStatus> {
  try {
    const executable = resolveVtdExecutable();
    const result = await runProcess(executable, ["--version"], VTD_VERSION_TIMEOUT_MS);
    if (result.exitCode !== 0 || result.timedOut) {
      return { installed: false };
    }
    return {
      installed: true,
      path: executable,
      ...(result.output.length > 0 ? { version: result.output } : {}),
    };
  } catch {
    return { installed: false };
  }
}

async function installVtdCli(): Promise<VtdInstallResult> {
  let temporaryDirectory: string | undefined;
  try {
    const installUrl = parseInstallUrl(process.env.VTD_INSTALL_URL ?? DEFAULT_VTD_INSTALL_URL);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "lichtblick-vtd-install-"));
    const installerPath = join(temporaryDirectory, "install.sh");
    const downloadResult = await runProcess("curl", [
      "-fsSL",
      "--proto",
      "=http,https",
      "--proto-redir",
      "=http,https",
      "--output",
      installerPath,
      installUrl,
    ]);
    if (downloadResult.exitCode !== 0) {
      return { exitCode: downloadResult.exitCode, ok: false, output: downloadResult.output };
    }

    const installResult = await runProcess("bash", [installerPath]);
    if (installResult.exitCode === 0) {
      invalidateVtdExecutableCache();
    }
    return {
      exitCode: installResult.exitCode,
      ok: installResult.exitCode === 0,
      output: installResult.output,
    };
  } catch (error) {
    return {
      exitCode: null,
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (temporaryDirectory != undefined) {
      await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

export function registerVtdIpcHandlers({
  app,
  ipcMain,
  service = new VtdCliService(),
}: RegisterVtdIpcHandlersOptions): VtdCliService {
  const trackedSenders = new Map<number, WebContents>();
  let installPromise: Promise<VtdInstallResult> | undefined;

  const trackSender = (sender: WebContents): void => {
    const previous = trackedSenders.get(sender.id);
    if (previous === sender) {
      return;
    }
    if (previous != undefined) {
      service.cancelOwner(sender.id);
    }
    trackedSenders.set(sender.id, sender);
    sender.once("destroyed", () => {
      if (trackedSenders.get(sender.id) === sender) {
        trackedSenders.delete(sender.id);
        service.cancelOwner(sender.id);
      }
    });
  };

  ipcMain.handle("vtd:invoke", async (event, request: unknown): Promise<VtdInvokeResult> => {
    trackSender(event.sender);
    if (typeof request !== "object" || request == undefined || Array.isArray(request)) {
      return {
        code: "invalid-request",
        message: "Invalid vtd invocation",
        ok: false,
      };
    }
    // This cast links the IPC envelope to the shared type only. VtdCliService validates every
    // renderer-controlled field before spawning.
    const invocation = request as Partial<VtdInvokeRequest>;
    try {
      return {
        ok: true,
        value: await service.invoke(
          event.sender.id,
          invocation.requestId,
          invocation.command,
          invocation.params,
        ),
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle("vtd:cancel", (event, requestId: unknown) => {
    trackSender(event.sender);
    service.cancel(event.sender.id, requestId);
  });

  ipcMain.handle("vtd:status", async (): Promise<VtdStatus> => {
    return await getVtdStatus();
  });

  ipcMain.handle("vtd:install", async (): Promise<VtdInstallResult> => {
    if (installPromise != undefined) {
      return await installPromise;
    }
    const currentInstall = installVtdCli();
    installPromise = currentInstall;
    void currentInstall.then(
      () => {
        if (installPromise === currentInstall) {
          installPromise = undefined;
        }
      },
      () => {
        if (installPromise === currentInstall) {
          installPromise = undefined;
        }
      },
    );
    return await currentInstall;
  });

  app.once("before-quit", (event) => {
    event.preventDefault();
    trackedSenders.clear();
    void service.shutdown().then(
      () => {
        app.quit();
      },
      () => {
        app.quit();
      },
    );
  });

  return service;
}
