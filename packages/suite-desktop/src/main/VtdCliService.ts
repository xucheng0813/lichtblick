// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { isAbsolute } from "path";
import { StringDecoder } from "string_decoder";

import type { VtdInvokeCommand, VtdInvokeErrorCode } from "../common/types";

const VTD_TIMEOUT_MS = 30_000;
const VTD_FORCE_KILL_DELAY_MS = 5_000;
const VTD_MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const VTD_MAX_STDERR_BYTES = 4 * 1024;
const VTD_MAX_CONCURRENCY = 4;
const VTD_MAX_STRING_LENGTH = 4096;
const VTD_MAX_TOPICS = 200;
const VTD_MAX_PAGE = 1_000_000;
const VTD_MAX_PAGE_SIZE = 1_000;
const VTD_MAX_ARG_BYTES = 128 * 1024;
const VTD_MAX_REQUEST_ID_LENGTH = 128;
const VTD_CANCEL_TOMBSTONE_TTL_MS = 10_000;
const VTD_MAX_CANCEL_TOMBSTONES_PER_OWNER = 1_000;
export const VTD_QUIT_GRACE_PERIOD_MS = 2_000;

const VTD_COMMANDS = new Set<VtdInvokeCommand>([
  "list",
  "detail",
  "topics",
  "url",
  "slice-store",
  "slice-get",
  "trigger",
]);

type ActiveInvocation = {
  child: ChildProcessWithoutNullStreams;
  forceKill: () => void;
  ownerId: number;
  terminate: (error: VtdCliError) => void;
};

export class VtdCliError extends Error {
  public constructor(
    public readonly code: VtdInvokeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VtdCliError";
  }
}

function cliError(code: VtdInvokeErrorCode, message: string, options?: ErrorOptions): VtdCliError {
  return new VtdCliError(code, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function parseRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > VTD_MAX_REQUEST_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw cliError("invalid-request", "Invalid vtd request id");
  }
  return value;
}

function parseOwnerId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw cliError("invalid-request", "Invalid vtd invocation owner");
  }
  return value;
}

function assertAllowedKeys(params: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const invalidKey = Object.keys(params).find((key) => !allowed.has(key));
  if (invalidKey != undefined) {
    throw cliError("invalid-request", `Unsupported parameter for vtd command: ${invalidKey}`);
  }
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > VTD_MAX_STRING_LENGTH) {
    throw cliError(
      "invalid-request",
      `vtd parameter ${key} must be a non-empty string of at most ${VTD_MAX_STRING_LENGTH} characters`,
    );
  }
  return value;
}

function requiredPositionalString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (value == undefined) {
    throw cliError("invalid-request", `vtd parameter ${key} is required`);
  }
  if (value.startsWith("-")) {
    throw cliError("invalid-request", `vtd parameter ${key} must not start with a hyphen`);
  }
  return value;
}

function optionalPositiveInteger(
  params: Record<string, unknown>,
  key: string,
  maximum: number,
): number | undefined {
  const value = params[key];
  if (value == undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw cliError(
      "invalid-request",
      `vtd parameter ${key} must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

function optionalTopics(params: Record<string, unknown>): string[] | undefined {
  const value = params.topics;
  if (value == undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > VTD_MAX_TOPICS) {
    throw cliError(
      "invalid-request",
      `vtd parameter topics must contain at most ${VTD_MAX_TOPICS} strings`,
    );
  }
  if (
    !value.every(
      (topic) =>
        typeof topic === "string" &&
        topic.length > 0 &&
        topic.length <= VTD_MAX_STRING_LENGTH &&
        !topic.includes(","),
    )
  ) {
    throw cliError(
      "invalid-request",
      `vtd parameter topics must be non-empty comma-free strings of at most ${VTD_MAX_STRING_LENGTH} characters`,
    );
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value == undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw cliError("invalid-request", `vtd parameter ${key} must be a boolean`);
  }
  return value;
}

function optionalEnum(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const value = optionalString(params, key);
  if (value == undefined) {
    return undefined;
  }
  if (!allowed.includes(value)) {
    throw cliError(
      "invalid-request",
      `vtd parameter ${key} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value;
}

function readParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw cliError("invalid-request", "vtd command parameters must be an object");
  }
  return value;
}

function appendStringFlag(
  args: string[],
  params: Record<string, unknown>,
  key: string,
  flag: string,
): void {
  const value = optionalString(params, key);
  if (value != undefined) {
    args.push(flag, value);
  }
}

function appendPositiveIntegerFlag(
  args: string[],
  params: Record<string, unknown>,
  key: string,
  flag: string,
  maximum: number,
): void {
  const value = optionalPositiveInteger(params, key, maximum);
  if (value != undefined) {
    args.push(flag, String(value));
  }
}

function appendEnumFlag(
  args: string[],
  params: Record<string, unknown>,
  key: string,
  flag: string,
  allowed: readonly string[],
): void {
  const value = optionalEnum(params, key, allowed);
  if (value != undefined) {
    args.push(flag, value);
  }
}

function appendBooleanFlag(
  args: string[],
  params: Record<string, unknown>,
  key: string,
  flag: string,
): void {
  if (optionalBoolean(params, key) === true) {
    args.push(flag);
  }
}

const VTD_ORDER_DIRECTIONS = ["ASC", "DESC"] as const;

/**
 * The `vtd list` filter surface, as a single table so the accepted-key allowlist and the emitted
 * argv can never drift apart. Accepting a key without emitting its flag would silently discard the
 * filter, which is worse than rejecting it.
 */
const VTD_LIST_STRING_FLAGS: ReadonlyArray<readonly [key: string, flag: string]> = [
  ["id", "--id"],
  ["botSn", "--bot-sn"],
  ["botSnExact", "--bot-sn-exact"],
  ["botName", "--bot-name"],
  ["triggerType", "--trigger-type"],
  ["dataType", "--data-type"],
  ["inspection", "--inspection"],
  ["fixData", "--fix-data"],
  ["start", "--start"],
  ["end", "--end"],
  ["at", "--at"],
  ["triggerTime", "--trigger-time"],
  ["queryStart", "--query-start"],
  ["queryEnd", "--query-end"],
  ["queryTime", "--query-time"],
  ["dataDay", "--data-day"],
  ["dataTos", "--data-tos"],
  ["orderBy", "--order-by"],
];

const VTD_LIST_ALLOWED_KEYS: readonly string[] = [
  ...VTD_LIST_STRING_FLAGS.map(([key]) => key),
  "orderDir",
  "page",
  "pageSize",
];

function buildArgs(command: VtdInvokeCommand, value: unknown): string[] {
  const params = readParams(value);
  const args: string[] = [command];
  switch (command) {
    case "list":
      assertAllowedKeys(params, VTD_LIST_ALLOWED_KEYS);
      for (const [key, flag] of VTD_LIST_STRING_FLAGS) {
        appendStringFlag(args, params, key, flag);
      }
      appendEnumFlag(args, params, "orderDir", "--order-dir", VTD_ORDER_DIRECTIONS);
      appendPositiveIntegerFlag(args, params, "page", "--page", VTD_MAX_PAGE);
      appendPositiveIntegerFlag(args, params, "pageSize", "--page-size", VTD_MAX_PAGE_SIZE);
      break;
    case "detail":
    case "topics":
    case "url":
      assertAllowedKeys(params, ["id"]);
      args.push(requiredPositionalString(params, "id"));
      break;
    case "slice-store": {
      assertAllowedKeys(params, ["id", "topics", "startNs", "endNs"]);
      args.push(requiredPositionalString(params, "id"));
      const topics = optionalTopics(params);
      if (topics != undefined && topics.length > 0) {
        args.push("--topics", topics.join(","));
      }
      appendStringFlag(args, params, "startNs", "--start-ns");
      appendStringFlag(args, params, "endNs", "--end-ns");
      break;
    }
    case "slice-get":
      assertAllowedKeys(params, ["sliceId"]);
      args.push(requiredPositionalString(params, "sliceId"));
      break;
    case "trigger":
      assertAllowedKeys(params, ["triggerId", "all"]);
      args.push(requiredPositionalString(params, "triggerId"));
      appendBooleanFlag(args, params, "all", "--all");
      break;
  }
  args.push("--json");
  const argBytes = args.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0);
  if (argBytes > VTD_MAX_ARG_BYTES) {
    throw cliError("invalid-request", `vtd arguments exceed ${VTD_MAX_ARG_BYTES} bytes`);
  }
  return args;
}

function parseCommand(value: unknown): VtdInvokeCommand {
  if (typeof value !== "string" || !VTD_COMMANDS.has(value as VtdInvokeCommand)) {
    throw cliError("unsupported-command", "Unsupported vtd command");
  }
  return value as VtdInvokeCommand;
}

function executablePath(): string {
  const configuredExecutable = process.env.VTD_CLI_PATH;
  if (configuredExecutable == undefined || configuredExecutable.length === 0) {
    // Production packaging is responsible for providing a trusted vtd on PATH.
    return "vtd";
  }
  if (!isAbsolute(configuredExecutable)) {
    throw cliError("process", "VTD_CLI_PATH must be an absolute path");
  }
  return configuredExecutable;
}

function appendTail(existing: Uint8Array, chunk: Uint8Array, maximumBytes: number): Uint8Array {
  if (chunk.byteLength >= maximumBytes) {
    return chunk.subarray(chunk.byteLength - maximumBytes);
  }
  const retained = Math.min(existing.byteLength, maximumBytes - chunk.byteLength);
  const result = new Uint8Array(retained + chunk.byteLength);
  result.set(existing.subarray(existing.byteLength - retained));
  result.set(chunk, retained);
  return result;
}

function processError(error: unknown): VtdCliError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return cliError("not-found", "vtd CLI executable was not found", {
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return cliError("permission-denied", "vtd CLI executable is not permitted", {
      cause: error,
    });
  }
  return cliError("process", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function withStderr(error: VtdCliError, stderr: Uint8Array): VtdCliError {
  const detail = Buffer.from(stderr).toString("utf8").trim();
  return detail.length > 0
    ? cliError(error.code, `${error.message}: ${detail}`, { cause: error })
    : error;
}

export default class VtdCliService {
  readonly #activeInvocations = new Map<string, ActiveInvocation>();
  readonly #activeEmptyWaiters = new Set<() => void>();
  readonly #cancelTombstones = new Map<string, number>();
  #cancelTombstoneCleanup: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  public async invoke(
    ownerIdValue: unknown,
    requestIdValue: unknown,
    commandValue: unknown,
    params: unknown,
  ): Promise<unknown> {
    const ownerId = parseOwnerId(ownerIdValue);
    const requestId = parseRequestId(requestIdValue);
    const invocationKey = this.#invocationKey(ownerId, requestId);
    this.#pruneCancelTombstones();
    if (this.#cancelTombstones.has(invocationKey)) {
      throw cliError("cancelled", "vtd CLI invocation was cancelled before it started");
    }
    if (this.#disposed) {
      throw cliError("cancelled", "vtd CLI service is shutting down");
    }

    // Treat every renderer value as hostile and finish all validation before consuming a slot.
    const command = parseCommand(commandValue);
    const args = buildArgs(command, params);
    const executable = executablePath();

    if (this.#activeInvocations.has(invocationKey)) {
      throw cliError("duplicate-request", "Duplicate vtd request id");
    }
    if (this.#activeInvocations.size >= VTD_MAX_CONCURRENCY) {
      throw cliError("concurrency-limit", "vtd CLI concurrency limit reached");
    }
    return await this.#spawn(ownerId, invocationKey, executable, args);
  }

  public cancel(ownerIdValue: unknown, requestIdValue: unknown): void {
    const ownerId = parseOwnerId(ownerIdValue);
    const requestId = parseRequestId(requestIdValue);
    const invocationKey = this.#invocationKey(ownerId, requestId);
    this.#pruneCancelTombstones();
    this.#cancelTombstones.delete(invocationKey);
    this.#cancelTombstones.set(invocationKey, Date.now() + VTD_CANCEL_TOMBSTONE_TTL_MS);
    const ownerPrefix = `${ownerId}:`;
    let ownerTombstones = 0;
    let oldestOwnerKey: string | undefined;
    for (const key of this.#cancelTombstones.keys()) {
      if (key.startsWith(ownerPrefix)) {
        oldestOwnerKey ??= key;
        ownerTombstones += 1;
      }
    }
    if (ownerTombstones > VTD_MAX_CANCEL_TOMBSTONES_PER_OWNER && oldestOwnerKey != undefined) {
      this.#cancelTombstones.delete(oldestOwnerKey);
    }
    this.#scheduleCancelTombstoneCleanup();
    this.#activeInvocations
      .get(invocationKey)
      ?.terminate(cliError("cancelled", "vtd CLI invocation was cancelled"));
  }

  public cancelOwner(ownerIdValue: unknown): void {
    const ownerId = parseOwnerId(ownerIdValue);
    const ownerPrefix = `${ownerId}:`;
    for (const invocationKey of this.#cancelTombstones.keys()) {
      if (invocationKey.startsWith(ownerPrefix)) {
        this.#cancelTombstones.delete(invocationKey);
      }
    }
    this.#resetCancelTombstoneCleanup();
    for (const activeInvocation of this.#activeInvocations.values()) {
      if (activeInvocation.ownerId === ownerId) {
        activeInvocation.terminate(cliError("cancelled", "vtd CLI invocation owner was destroyed"));
      }
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelTombstones.clear();
    if (this.#cancelTombstoneCleanup != undefined) {
      clearTimeout(this.#cancelTombstoneCleanup);
      this.#cancelTombstoneCleanup = undefined;
    }
    for (const activeInvocation of this.#activeInvocations.values()) {
      activeInvocation.terminate(cliError("cancelled", "vtd CLI service is shutting down"));
    }
  }

  public async shutdown(): Promise<void> {
    this.dispose();
    if (this.#activeInvocations.size === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(forceKillTimer);
        this.#activeEmptyWaiters.delete(finish);
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        for (const activeInvocation of this.#activeInvocations.values()) {
          activeInvocation.forceKill();
        }
        finish();
      }, VTD_QUIT_GRACE_PERIOD_MS);
      this.#activeEmptyWaiters.add(finish);

      // A child may have closed between the initial size check and waiter registration.
      if (this.#activeInvocations.size === 0) {
        finish();
      }
    });
  }

  #invocationKey(ownerId: number, requestId: string): string {
    return `${ownerId}:${requestId}`;
  }

  #pruneCancelTombstones(): void {
    const now = Date.now();
    for (const [invocationKey, expiresAt] of this.#cancelTombstones) {
      if (expiresAt <= now) {
        this.#cancelTombstones.delete(invocationKey);
      }
    }
  }

  #resetCancelTombstoneCleanup(): void {
    if (this.#cancelTombstoneCleanup != undefined) {
      clearTimeout(this.#cancelTombstoneCleanup);
      this.#cancelTombstoneCleanup = undefined;
    }
    this.#scheduleCancelTombstoneCleanup();
  }

  #scheduleCancelTombstoneCleanup(): void {
    if (this.#cancelTombstoneCleanup != undefined || this.#cancelTombstones.size === 0) {
      return;
    }
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const expiresAt of this.#cancelTombstones.values()) {
      earliestExpiry = Math.min(earliestExpiry, expiresAt);
    }
    this.#cancelTombstoneCleanup = setTimeout(
      () => {
        this.#cancelTombstoneCleanup = undefined;
        this.#pruneCancelTombstones();
        this.#scheduleCancelTombstoneCleanup();
      },
      Math.max(0, earliestExpiry - Date.now()),
    );
    this.#cancelTombstoneCleanup.unref();
  }

  async #spawn(
    ownerId: number,
    invocationKey: string,
    executable: string,
    args: string[],
  ): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, args, { shell: false });
      } catch (error) {
        reject(processError(error));
        return;
      }

      let outputBytes = 0;
      const decoder = new StringDecoder("utf8");
      const output: string[] = [];
      let stderr: Uint8Array = new Uint8Array();
      let pendingError: VtdCliError | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;

      const forceKill = (): void => {
        if (closed) {
          return;
        }
        if (forceKillTimer != undefined) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        child.kill("SIGKILL");
      };

      const terminate = (error: VtdCliError): void => {
        if (closed || pendingError != undefined) {
          return;
        }
        pendingError = error;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          forceKill();
        }, VTD_FORCE_KILL_DELAY_MS);
      };

      const timeout = setTimeout(() => {
        terminate(cliError("timeout", `vtd CLI timed out after ${VTD_TIMEOUT_MS}ms`));
      }, VTD_TIMEOUT_MS);

      this.#activeInvocations.set(invocationKey, {
        child,
        forceKill,
        ownerId,
        terminate,
      });

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (closed || pendingError != undefined) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > VTD_MAX_STDOUT_BYTES) {
          terminate(
            cliError("output-limit", `vtd CLI output exceeded ${VTD_MAX_STDOUT_BYTES} bytes`),
          );
          return;
        }
        output.push(decoder.write(buffer));
      });
      child.stdout.on("error", (error) => {
        terminate(cliError("stream", `vtd CLI stdout failed: ${error.message}`));
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderr = appendTail(stderr, Uint8Array.from(buffer), VTD_MAX_STDERR_BYTES);
      });
      child.stderr.on("error", (error) => {
        terminate(cliError("stream", `vtd CLI stderr failed: ${error.message}`));
      });

      child.on("error", (error) => {
        terminate(processError(error));
      });
      child.on("close", (code) => {
        if (closed) {
          return;
        }
        closed = true;
        clearTimeout(timeout);
        if (forceKillTimer != undefined) {
          clearTimeout(forceKillTimer);
        }
        const activeInvocation = this.#activeInvocations.get(invocationKey);
        if (activeInvocation?.child === child) {
          this.#activeInvocations.delete(invocationKey);
          if (this.#activeInvocations.size === 0) {
            for (const waiter of [...this.#activeEmptyWaiters]) {
              waiter();
            }
          }
        }

        if (pendingError != undefined) {
          reject(withStderr(pendingError, stderr));
          return;
        }
        if (code !== 0) {
          reject(withStderr(cliError("exit", `vtd CLI exited with code ${String(code)}`), stderr));
          return;
        }
        try {
          output.push(decoder.end());
          resolve(JSON.parse(output.join("")) as unknown);
        } catch (error) {
          reject(
            cliError(
              "invalid-json",
              `vtd CLI returned invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });
    });
  }
}
