// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 8770;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_LEAK_GRACE_MS = 5_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_CONCURRENCY_LIMIT = 8;
const DEFAULT_PENDING_BODY_LIMIT = 32;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_STRING_LENGTH = 4096;
const MAX_TOPICS = 200;
const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 100;

const DEFAULT_LAYOUT_PLACEHOLDER =
  "/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/";
const STATIC_MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

const ERROR_BAD_REQUEST = "bad-request";
const ERROR_TIMEOUT = "timeout";
const ERROR_UPSTREAM = "upstream-error";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SIGNED_INTEGER_PATTERN = /^-?\d+$/;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

function option(flag, kind = "string", extra = undefined) {
  return { flag, kind, ...extra };
}

function options(entries) {
  return new Map(entries);
}

// Map lookup is intentional: a plain object would make names such as
// "__proto__" and "constructor" part of the effective command surface.
const COMMAND_SPECS = new Map([
  [
    "list",
    {
      params: options([
        ["page", option("--page", "integer", { min: 1, max: MAX_PAGE })],
        [
          "pageSize",
          option("--page-size", "integer", { min: 1, max: MAX_PAGE_SIZE }),
        ],
        ["id", option("--id", "id")],
        ["botName", option("--bot-name")],
        ["botSn", option("--bot-sn")],
        ["botSnExact", option("--bot-sn-exact")],
        ["triggerType", option("--trigger-type")],
        ["dataType", option("--data-type")],
        ["inspection", option("--inspection")],
        ["fixData", option("--fix-data")],
        ["start", option("--start", "time")],
        ["end", option("--end", "time")],
        ["at", option("--at", "time")],
        ["triggerTime", option("--trigger-time", "time")],
        ["queryStart", option("--query-start", "time")],
        ["queryEnd", option("--query-end", "time")],
        ["queryTime", option("--query-time", "time")],
        ["dataDay", option("--data-day")],
        ["dataTos", option("--data-tos")],
        ["orderBy", option("--order-by")],
        [
          "orderDir",
          option("--order-dir", "enum", { values: ["ASC", "DESC"] }),
        ],
      ]),
    },
  ],
  [
    "detail",
    {
      positional: { key: "id", kind: "id" },
      params: options([]),
    },
  ],
  [
    "topics",
    {
      positional: { key: "id", kind: "id" },
      params: options([]),
      fixedFlags: ["--count"],
    },
  ],
  [
    "url",
    {
      positional: { key: "id", kind: "id" },
      params: options([]),
    },
  ],
  [
    "slice-store",
    {
      positional: { key: "id", kind: "id" },
      params: options([
        ["topics", option("--topics", "topics")],
        ["startNs", option("--start-ns", "nanoseconds")],
        ["endNs", option("--end-ns", "nanoseconds")],
      ]),
    },
  ],
  [
    "slice-get",
    {
      positional: { key: "sliceId", kind: "id" },
      params: options([]),
    },
  ],
  [
    "trigger",
    {
      positional: { key: "triggerId", kind: "id" },
      params: options([["all", option("--all", "boolean")]]),
    },
  ],
]);

class SidecarError extends Error {
  constructor(statusCode, category, internalMessage) {
    super(internalMessage);
    this.name = "SidecarError";
    this.statusCode = statusCode;
    this.category = category;
  }
}

function badRequest(message, statusCode = 400) {
  return new SidecarError(statusCode, ERROR_BAD_REQUEST, message);
}

function upstreamError(message) {
  return new SidecarError(502, ERROR_UPSTREAM, message);
}

function timeoutError(message) {
  return new SidecarError(504, ERROR_TIMEOUT, message);
}

function requestTimeoutError(message) {
  return new SidecarError(408, ERROR_TIMEOUT, message);
}

function sanitizeLogMessage(value) {
  const sanitized = String(value)
    .replace(
      /authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi,
      "Authorization: Bearer [REDACTED]",
    )
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\btos:\/\/[^\s"'<>]+/gi, "tos://[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      const withoutUserInfo = url.replace(
        /^(https?:\/\/)[^/?#@\s]+@/i,
        "$1[REDACTED]@",
      );
      const requestSuffixIndex = [
        withoutUserInfo.indexOf("?"),
        withoutUserInfo.indexOf("#"),
      ]
        .filter((index) => index >= 0)
        .reduce(
          (minimum, index) => Math.min(minimum, index),
          Number.POSITIVE_INFINITY,
        );
      return Number.isFinite(requestSuffixIndex)
        ? `${withoutUserInfo.slice(0, requestSuffixIndex)}?[REDACTED]`
        : withoutUserInfo;
    });
  return Array.from(sanitized, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (codePoint <= 0x1f || codePoint === 0x7f)
      ? " "
      : character;
  })
    .join("")
    .slice(0, 4096);
}

function logError(message) {
  console.error(`[vtd-sidecar] ${sanitizeLogMessage(message)}`);
}

function parsePositiveInteger(value, name) {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return numberValue;
}

function readEnvironmentInteger(value, fallback, name) {
  return value == null || value === ""
    ? fallback
    : parsePositiveInteger(value, name);
}

function validateString(value, key, { allowLeadingDash = false } = {}) {
  if (typeof value !== "string") {
    throw badRequest(`Parameter "${key}" must be a string`);
  }
  if (value.length === 0 || value.length > MAX_STRING_LENGTH) {
    throw badRequest(
      `Parameter "${key}" must contain between 1 and ${MAX_STRING_LENGTH} characters`,
    );
  }
  if ((!allowLeadingDash && value.startsWith("-")) || value.includes("\0")) {
    throw badRequest(`Parameter "${key}" contains a forbidden value`);
  }
  return value;
}

function validateInt64String(value, key) {
  const stringValue = validateString(value, key, { allowLeadingDash: true });
  if (!SIGNED_INTEGER_PATTERN.test(stringValue)) {
    throw badRequest(`Parameter "${key}" must be a signed decimal integer`);
  }
  let bigintValue;
  try {
    bigintValue = BigInt(stringValue);
  } catch {
    throw badRequest(`Parameter "${key}" must be a signed decimal integer`);
  }
  if (bigintValue < INT64_MIN || bigintValue > INT64_MAX) {
    throw badRequest(`Parameter "${key}" must fit in a signed 64-bit integer`);
  }
  return stringValue;
}

function validateValue(value, key, descriptor) {
  switch (descriptor.kind) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw badRequest(`Parameter "${key}" must be a boolean`);
      }
      return value;
    case "integer":
      if (
        !Number.isSafeInteger(value) ||
        value < descriptor.min ||
        value > descriptor.max
      ) {
        throw badRequest(
          `Parameter "${key}" must be an integer between ${descriptor.min} and ${descriptor.max}`,
        );
      }
      return String(value);
    case "id": {
      const stringValue = validateString(value, key);
      if (!ID_PATTERN.test(stringValue)) {
        throw badRequest(`Parameter "${key}" is not a valid identifier`);
      }
      return stringValue;
    }
    case "nanoseconds": {
      return validateInt64String(value, key);
    }
    case "time": {
      const stringValue = validateString(value, key, {
        allowLeadingDash: true,
      });
      if (SIGNED_INTEGER_PATTERN.test(stringValue)) {
        return validateInt64String(stringValue, key);
      }
      if (stringValue.startsWith("-")) {
        throw badRequest(`Parameter "${key}" contains a forbidden value`);
      }
      return stringValue;
    }
    case "enum": {
      const stringValue = validateString(value, key);
      if (!descriptor.values.includes(stringValue)) {
        throw badRequest(`Parameter "${key}" has an unsupported value`);
      }
      return stringValue;
    }
    case "topics":
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_TOPICS
      ) {
        throw badRequest(
          `Parameter "${key}" must contain between 1 and ${MAX_TOPICS} topics`,
        );
      }
      return value
        .map((topic, index) => {
          const stringValue = validateString(topic, `${key}[${index}]`);
          // Topic names are opaque to the CLI and real recordings contain names
          // without a leading slash (e.g. "aorta/...", "collectd/..."). The only
          // structural constraint is the comma, because topics are joined with
          // "," into a single CLI argument below.
          if (stringValue.includes(",")) {
            throw badRequest(`Parameter "${key}" contains an invalid topic`);
          }
          return stringValue;
        })
        .join(",");
    case "string":
      return validateString(value, key);
    default:
      throw upstreamError(`Unknown validator kind for parameter "${key}"`);
  }
}

export function buildVtdArgs(command, params) {
  const commandSpec = COMMAND_SPECS.get(command);
  if (commandSpec == null) {
    throw badRequest(`Unsupported vtd command "${command}"`, 404);
  }
  if (
    params == null ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.getPrototypeOf(params) !== Object.prototype
  ) {
    throw badRequest("Request body must be a JSON object");
  }

  const args = [command];
  const consumedKeys = new Set();

  if (commandSpec.positional != null) {
    const { key, kind } = commandSpec.positional;
    if (!Object.hasOwn(params, key)) {
      throw badRequest(`Missing required parameter "${key}"`);
    }
    args.push(validateValue(params[key], key, { kind }));
    consumedKeys.add(key);
  }

  for (const [key, descriptor] of commandSpec.params) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    const value = validateValue(params[key], key, descriptor);
    consumedKeys.add(key);
    if (descriptor.kind === "boolean") {
      if (value) {
        args.push(descriptor.flag);
      }
    } else {
      // Keep the flag and its value in one argv entry. Together with shell:false
      // a signed numeric value cannot become another option.
      args.push(`${descriptor.flag}=${value}`);
    }
  }

  for (const key of Object.keys(params)) {
    if (!consumedKeys.has(key)) {
      throw badRequest(
        `Unsupported parameter "${key}" for command "${command}"`,
      );
    }
  }

  args.push(...(commandSpec.fixedFlags ?? []), "--json");
  return args;
}

function sendJson(response, statusCode, value, corsHeaders) {
  response.writeHead(statusCode, {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function isWithinRoot(root, target) {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

function serializeDefaultLayout(defaultLayout) {
  let parsed;
  try {
    parsed = JSON.parse(defaultLayout);
  } catch {
    throw new Error("LICHTBLICK_SUITE_DEFAULT_LAYOUT must contain valid JSON");
  }
  return JSON.stringify(parsed)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function createStaticFileConfig(staticRoot, defaultLayout) {
  if (staticRoot === "") {
    return undefined;
  }
  const root = realpathSync(resolve(staticRoot));
  const indexPath = realpathSync(join(root, "index.html"));
  if (!isWithinRoot(root, indexPath)) {
    throw new Error(
      "STATIC_ROOT index.html resolves outside the configured root",
    );
  }
  const originalIndex = readFileSync(indexPath, "utf8");
  const serializedDefaultLayout =
    defaultLayout == null ? undefined : serializeDefaultLayout(defaultLayout);
  const indexHtml = Buffer.from(
    serializedDefaultLayout == null
      ? originalIndex
      : originalIndex.replace(DEFAULT_LAYOUT_PLACEHOLDER, () => serializedDefaultLayout),
    "utf8",
  );
  return { indexHtml, indexPath, root };
}

function decodeStaticPath(rawRequestUrl) {
  const rawPath = rawRequestUrl.split(/[?#]/u, 1)[0] ?? "/";
  if (rawPath.includes("\\") || /%00/iu.test(rawPath)) {
    throw badRequest("Static path contains a forbidden value");
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw badRequest("Static path is not valid URL encoding");
  }
  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("\0") ||
    decodedPath.includes("\\")
  ) {
    throw badRequest("Static path contains a forbidden value");
  }
  return decodedPath;
}

function isMissingFileError(error) {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function resolveStaticFile(staticFiles, decodedPath) {
  let candidate = resolve(staticFiles.root, `.${decodedPath}`);
  if (!isWithinRoot(staticFiles.root, candidate)) {
    throw badRequest("Static path escapes the configured root");
  }
  try {
    let candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = join(candidate, "index.html");
      candidateStat = await stat(candidate);
    }
    if (!candidateStat.isFile()) {
      return undefined;
    }
    const realCandidate = await realpath(candidate);
    if (!isWithinRoot(staticFiles.root, realCandidate)) {
      throw badRequest("Static path resolves outside the configured root");
    }
    return { path: realCandidate, size: candidateStat.size };
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function staticHeaders(path, contentLength, cors) {
  return {
    ...cors,
    "Content-Length": contentLength,
    "Content-Type":
      STATIC_MIME_TYPES.get(extname(path).toLowerCase()) ??
      "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  };
}

async function sendStaticResponse(request, response, staticFiles, cors) {
  const decodedPath = decodeStaticPath(request.url ?? "/");
  const file = await resolveStaticFile(staticFiles, decodedPath);
  const acceptsHtml = request.headers.accept
    ?.split(",")
    .some(
      (value) => value.split(";", 1)[0]?.trim().toLowerCase() === "text/html",
    );
  const useIndex =
    file?.path === staticFiles.indexPath ||
    (file == null && acceptsHtml === true);

  if (useIndex) {
    response.writeHead(
      200,
      staticHeaders(staticFiles.indexPath, staticFiles.indexHtml.length, cors),
    );
    response.end(request.method === "HEAD" ? undefined : staticFiles.indexHtml);
    return;
  }
  if (file == null) {
    throw badRequest("Static file was not found", 404);
  }

  response.writeHead(200, staticHeaders(file.path, file.size, cors));
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(file.path), response);
}

function corsHeaders(allowOrigin, authToken) {
  if (allowOrigin === "") {
    return {};
  }
  const allowedHeaders =
    authToken === "" ? "Content-Type" : "Content-Type, Authorization";
  return {
    "Access-Control-Allow-Headers": allowedHeaders,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
  };
}

function assertAllowedOrigin(request, allowOrigin) {
  const origin = request.headers.origin;
  if (
    origin != null &&
    allowOrigin !== "" &&
    allowOrigin !== "*" &&
    origin !== allowOrigin
  ) {
    throw badRequest("Origin is not allowed", 403);
  }
}

function assertAuthorization(request, authToken) {
  if (authToken === "") {
    return;
  }
  const actual = request.headers.authorization;
  const expected = `Bearer ${authToken}`;
  if (typeof actual !== "string") {
    throw badRequest("Authorization failed", 401);
  }
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw badRequest("Authorization failed", 401);
  }
}

function assertJsonContentType(request) {
  const contentType = request.headers["content-type"];
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw badRequest("Content-Type must be application/json", 415);
  }
}

function readJsonBody(request, bodyTimeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;

    const cleanup = () => {
      clearTimeout(timeout);
      request.removeListener("data", onData);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onError);
      request.removeListener("end", onEnd);
    };
    const fail = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      if (finished) {
        return;
      }
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        fail(badRequest("Request body is too large", 413));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onAborted = () => {
      fail(badRequest("Request was aborted"));
    };
    const onError = (error) => {
      fail(badRequest(`Failed to read request body: ${error.message}`));
    };
    const onEnd = () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(body));
      } catch (error) {
        reject(
          badRequest(
            `Request body is not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    };
    const timeout = setTimeout(() => {
      fail(
        requestTimeoutError(
          `Request body was not completed within ${bodyTimeoutMs} ms`,
        ),
      );
      request.resume();
    }, bodyTimeoutMs);
    timeout.unref?.();

    request.on("data", onData);
    request.once("aborted", onAborted);
    request.once("error", onError);
    request.once("end", onEnd);
  });
}

function executeVtd({
  args,
  killGraceMs,
  leakGraceMs,
  maxOutputBytes,
  onLeaked,
  onLeakedClose,
  signal,
  spawnImpl,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(timeoutError("Client disconnected before vtd started"));
      return;
    }
    let child;
    try {
      child = spawnImpl("vtd", args, { shell: false });
    } catch (error) {
      reject(
        upstreamError(
          `Failed to spawn vtd: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let pendingError;
    let closed = false;
    let leaked = false;
    let settled = false;
    let forceKillTimer;
    let leakTimer;
    let commandTimeout;

    const cleanupTimersAndSignal = () => {
      clearTimeout(commandTimeout);
      clearTimeout(forceKillTimer);
      clearTimeout(leakTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimersAndSignal();
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimersAndSignal();
      resolve(value);
    };
    const sendSignal = (childSignal) => {
      try {
        if (!child.kill(childSignal)) {
          logError(`vtd child rejected ${childSignal}`);
        }
      } catch (killError) {
        logError(
          `Failed to send ${childSignal}: ${
            killError instanceof Error ? killError.message : String(killError)
          }`,
        );
      }
    };
    const forceKill = () => {
      if (closed) {
        return;
      }
      // Install the final deadline before kill() so a synchronous close can
      // clear it and cannot leave a stale timer behind.
      leakTimer = setTimeout(() => {
        if (closed) {
          return;
        }
        leaked = true;
        onLeaked();
        logError(
          "vtd child did not emit close after SIGKILL; process marked leaked",
        );
        rejectOnce(
          timeoutError("vtd process did not close after forced termination"),
        );
      }, leakGraceMs);
      leakTimer.unref?.();
      sendSignal("SIGKILL");
      if (closed) {
        clearTimeout(leakTimer);
      }
    };
    const terminate = (error) => {
      if (pendingError != null || settled) {
        return;
      }
      pendingError = error;
      // Install before SIGTERM to make synchronous close safe.
      forceKillTimer = setTimeout(() => {
        forceKill();
      }, killGraceMs);
      forceKillTimer.unref?.();
      sendSignal("SIGTERM");
      if (closed) {
        clearTimeout(forceKillTimer);
      }
    };
    const onAbort = () => {
      terminate(timeoutError("Client disconnected before vtd completed"));
    };
    const onClose = (code, closeSignal) => {
      closed = true;
      if (leaked) {
        onLeakedClose();
      }
      cleanupTimersAndSignal();

      if (pendingError != null) {
        rejectOnce(pendingError);
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        rejectOnce(
          upstreamError(
            `vtd exited with code ${String(code)} and signal ${String(
              closeSignal,
            )}; stderr: ${stderr}`,
          ),
        );
        return;
      }
      const stdout = Buffer.concat(stdoutChunks);
      try {
        JSON.parse(stdout.toString("utf8"));
      } catch (error) {
        rejectOnce(
          upstreamError(
            `vtd returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      resolveOnce(stdout);
    };
    child.once("close", onClose);

    const collect = (streamName, chunk) => {
      if (pendingError != null) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        terminate(
          upstreamError(
            `vtd output exceeded configured limit of ${maxOutputBytes} bytes`,
          ),
        );
        return;
      }
      if (streamName === "stdout") {
        stdoutChunks.push(buffer);
      } else {
        stderrChunks.push(buffer);
      }
    };

    child.stdout.on("data", (chunk) => {
      collect("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      collect("stderr", chunk);
    });
    child.stdout.once("error", (error) => {
      terminate(upstreamError(`Failed to read vtd stdout: ${error.message}`));
    });
    child.stderr.once("error", (error) => {
      terminate(upstreamError(`Failed to read vtd stderr: ${error.message}`));
    });
    child.once("error", (error) => {
      terminate(upstreamError(`vtd process error: ${error.message}`));
    });

    commandTimeout = setTimeout(() => {
      terminate(timeoutError(`vtd command exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    commandTimeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
    }
  });
}

function normalizeError(error) {
  if (error instanceof SidecarError) {
    return error;
  }
  return upstreamError(
    error instanceof Error
      ? error.message
      : `Unexpected error: ${String(error)}`,
  );
}

export function createVtdSidecarServer({
  allowOrigin = process.env.ALLOW_ORIGIN ?? "",
  authToken = process.env.AUTH_TOKEN ?? "",
  bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
  concurrencyLimit = DEFAULT_CONCURRENCY_LIMIT,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  leakGraceMs = DEFAULT_LEAK_GRACE_MS,
  maxOutputBytes = readEnvironmentInteger(
    process.env.MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
    "MAX_OUTPUT_BYTES",
  ),
  pendingBodyLimit = DEFAULT_PENDING_BODY_LIMIT,
  spawnImpl = spawn,
  staticRoot = process.env.STATIC_ROOT ?? "",
  defaultLayout = process.env.LICHTBLICK_SUITE_DEFAULT_LAYOUT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  for (const [value, name] of [
    [bodyTimeoutMs, "bodyTimeoutMs"],
    [concurrencyLimit, "concurrencyLimit"],
    [killGraceMs, "killGraceMs"],
    [leakGraceMs, "leakGraceMs"],
    [maxOutputBytes, "maxOutputBytes"],
    [pendingBodyLimit, "pendingBodyLimit"],
    [timeoutMs, "timeoutMs"],
  ]) {
    parsePositiveInteger(value, name);
  }

  let activeCommands = 0;
  let pendingBodies = 0;
  const staticFiles = createStaticFileConfig(staticRoot, defaultLayout);

  return createHttpServer(async (request, response) => {
    const headers = corsHeaders(allowOrigin, authToken);
    let ownsLeakedSlot = false;
    let ownsPendingBody = false;
    let ownsSlot = false;
    let removeDisconnectListeners = () => {};

    try {
      assertAllowedOrigin(request, allowOrigin);
      const requestUrl = new URL(request.url ?? "/", "http://sidecar.invalid");

      if (requestUrl.pathname === "/healthz") {
        if (request.method !== "GET") {
          throw badRequest("Method is not allowed", 405);
        }
        sendJson(response, 200, { status: "ok" }, headers);
        return;
      }

      if (
        staticFiles != null &&
        !requestUrl.pathname.startsWith("/vtd/") &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        await sendStaticResponse(request, response, staticFiles, headers);
        return;
      }

      const match = /^\/vtd\/([^/]+)$/.exec(requestUrl.pathname);
      const command = match?.[1];
      if (command == null || !COMMAND_SPECS.has(command)) {
        throw badRequest("Unsupported vtd command", 404);
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        throw badRequest("Method is not allowed", 405);
      }

      assertAuthorization(request, authToken);
      assertJsonContentType(request);

      // Bound slow/incomplete bodies separately from the scarce child-process
      // slots. The check and increment are one synchronous section.
      if (pendingBodies >= pendingBodyLimit) {
        throw badRequest("Pending request-body limit exceeded", 429);
      }
      pendingBodies += 1;
      ownsPendingBody = true;
      let params;
      try {
        params = await readJsonBody(request, bodyTimeoutMs);
      } finally {
        pendingBodies -= 1;
        ownsPendingBody = false;
      }
      const args = buildVtdArgs(command, params);

      // Occupy a CLI slot only after the complete body is parsed. The check and
      // increment remain consecutive and synchronous, so completed requests
      // cannot pass through the limit together.
      if (activeCommands >= concurrencyLimit) {
        throw badRequest("Concurrency limit exceeded", 429);
      }
      activeCommands += 1;
      ownsSlot = true;

      const disconnectController = new AbortController();
      const onRequestAborted = () => {
        disconnectController.abort(
          new DOMException("Client disconnected", "AbortError"),
        );
      };
      const onResponseClose = () => {
        if (!response.writableEnded) {
          onRequestAborted();
        }
      };
      request.once("aborted", onRequestAborted);
      response.once("close", onResponseClose);
      removeDisconnectListeners = () => {
        request.removeListener("aborted", onRequestAborted);
        response.removeListener("close", onResponseClose);
      };
      if (request.aborted || response.destroyed) {
        onRequestAborted();
      }

      const stdout = await executeVtd({
        args,
        killGraceMs,
        leakGraceMs,
        maxOutputBytes,
        onLeaked: () => {
          // A process that has not emitted close still consumes OS resources.
          // Transfer ownership of its slot out of the completed HTTP request so
          // the configured process bound remains true.
          ownsSlot = false;
          ownsLeakedSlot = true;
        },
        onLeakedClose: () => {
          if (ownsLeakedSlot) {
            ownsLeakedSlot = false;
            activeCommands -= 1;
          }
        },
        signal: disconnectController.signal,
        spawnImpl,
        timeoutMs,
      });
      response.writeHead(200, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(stdout);
    } catch (error) {
      const normalized = normalizeError(error);
      logError(normalized.message);
      if (!response.headersSent && !response.destroyed) {
        sendJson(
          response,
          normalized.statusCode,
          { error: normalized.category },
          headers,
        );
      } else {
        response.destroy();
      }
    } finally {
      removeDisconnectListeners();
      if (ownsPendingBody) {
        pendingBodies -= 1;
      }
      if (ownsSlot) {
        activeCommands -= 1;
      }
    }
  });
}

function startFromEnvironment() {
  const port = readEnvironmentInteger(process.env.PORT, DEFAULT_PORT, "PORT");
  const server = createVtdSidecarServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`[vtd-sidecar] listening on port ${port}`);
  });
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    startFromEnvironment();
  } catch (error) {
    logError(
      `startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
