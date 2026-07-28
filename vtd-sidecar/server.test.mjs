// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createVtdSidecarServer } from "./server.mjs";

function createMockChild({
  autoClose = true,
  code = 0,
  closeOnSignal,
  killReturn = true,
  stderr = "",
  stdout = "{}",
  synchronousCloseOnSignal,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.closed = false;
  child.finish = (finishCode = code, signal = null) => {
    if (child.closed) {
      return;
    }
    child.closed = true;
    if (stdout.length > 0) {
      child.stdout.write(stdout);
    }
    if (stderr.length > 0) {
      child.stderr.write(stderr);
    }
    child.stdout.end();
    child.stderr.end();
    child.emit("close", finishCode, signal);
  };
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (signal === synchronousCloseOnSignal) {
      child.finish(null, signal);
    }
    if (signal === closeOnSignal) {
      queueMicrotask(() => {
        child.finish(null, signal);
      });
    }
    return killReturn;
  };

  if (autoClose) {
    queueMicrotask(() => {
      child.finish();
    });
  }
  return child;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error != null) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function collectResponse(response, resolve) {
  const chunks = [];
  response.on("data", (chunk) => {
    chunks.push(chunk);
  });
  response.on("end", () => {
    resolve({
      body: Buffer.concat(chunks).toString("utf8"),
      headers: response.headers,
      statusCode: response.statusCode,
    });
  });
}

function sendRequest(
  port,
  {
    body,
    contentType = body == null ? undefined : "application/json",
    headers = {},
    method = "POST",
    path,
    rawBody,
  },
) {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? (body == null ? undefined : JSON.stringify(body));
    const requestHeaders = { ...headers };
    if (payload != null) {
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    if (contentType != null) {
      requestHeaders["Content-Type"] = contentType;
    }
    const request = httpRequest(
      {
        headers: requestHeaders,
        host: "127.0.0.1",
        method,
        path,
        port,
      },
      (response) => {
        collectResponse(response, resolve);
      },
    );
    request.on("error", reject);
    if (payload != null) {
      request.write(payload);
    }
    request.end();
  });
}

function openSlowJsonRequest(port, path) {
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(
    {
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
      host: "127.0.0.1",
      method: "POST",
      path,
      port,
    },
    (response) => {
      collectResponse(response, resolveResponse);
    },
  );
  request.on("error", rejectResponse);
  request.write("{");
  return { request, responsePromise };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

test("rejects unknown and prototype-chain command names", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    for (const command of ["delete", "__proto__", "constructor", "toString"]) {
      const response = await sendRequest(port, {
        body: {},
        path: `/vtd/${command}`,
      });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(JSON.parse(response.body), { error: "bad-request" });
    }
    assert.equal(spawnCalls.length, 0);
  } finally {
    await close(server);
  }
});

test("maps values as --flag=value argv entries and preserves stdout JSON", async () => {
  const spawnCalls = [];
  const rawJson = '{"data":[],"total":0}\n';
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild({ stdout: rawJson });
    },
  });
  const port = await listen(server);

  try {
    const response = await sendRequest(port, {
      body: {
        at: "2026-01-02 03:04:05",
        botName: "robot",
        botSn: "SN001",
        end: "2026-01-03",
        page: 2,
        pageSize: 50,
        start: "2026-01-01",
        triggerType: "nav",
      },
      path: "/vtd/list",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, rawJson);
    assert.deepEqual(spawnCalls, [
      [
        "vtd",
        [
          "list",
          "--page=2",
          "--page-size=50",
          "--bot-name=robot",
          "--bot-sn=SN001",
          "--trigger-type=nav",
          "--start=2026-01-01",
          "--end=2026-01-03",
          "--at=2026-01-02 03:04:05",
          "--json",
        ],
        { shell: false },
      ],
    ]);
  } finally {
    await close(server);
  }
});

test("maps slice topics and nanosecond strings without losing precision", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild({ stdout: '{"mcap_slice_id":"slice-1"}' });
    },
  });
  const port = await listen(server);

  try {
    const response = await sendRequest(port, {
      body: {
        endNs: "1700000000000000099",
        id: "1234",
        startNs: "1700000000000000001",
        topics: ["/imu", "/odom"],
      },
      path: "/vtd/slice-store",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(spawnCalls[0], [
      "vtd",
      [
        "slice-store",
        "1234",
        "--topics=/imu,/odom",
        "--start-ns=1700000000000000001",
        "--end-ns=1700000000000000099",
        "--json",
      ],
      { shell: false },
    ]);
  } finally {
    await close(server);
  }
});

test("accepts signed int64 times and rejects values outside int64", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const listResponse = await sendRequest(port, {
      body: {
        queryTime: "-9223372036854775808",
        start: "-1",
      },
      path: "/vtd/list",
    });
    assert.equal(listResponse.statusCode, 200);
    assert.deepEqual(spawnCalls[0]?.[1], [
      "list",
      "--start=-1",
      "--query-time=-9223372036854775808",
      "--json",
    ]);

    const sliceResponse = await sendRequest(port, {
      body: {
        endNs: "9223372036854775807",
        id: "1234",
        startNs: "-9223372036854775808",
      },
      path: "/vtd/slice-store",
    });
    assert.equal(sliceResponse.statusCode, 200);
    assert.deepEqual(spawnCalls[1]?.[1], [
      "slice-store",
      "1234",
      "--start-ns=-9223372036854775808",
      "--end-ns=9223372036854775807",
      "--json",
    ]);

    for (const value of ["-9223372036854775809", "9223372036854775808"]) {
      const response = await sendRequest(port, {
        body: { id: "1234", startNs: value },
        path: "/vtd/slice-store",
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(JSON.parse(response.body), { error: "bad-request" });
    }
    assert.equal(spawnCalls.length, 2);
  } finally {
    await close(server);
  }
});

test("rejects leading-dash values, invalid IDs, and unsupported parameters", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const cases = [
      ["/vtd/list", { botName: "--env=test" }],
      ["/vtd/detail", { id: "-1" }],
      ["/vtd/slice-store", { id: "1234", topics: ["--json"] }],
      ["/vtd/list", { env: "test" }],
    ];
    for (const [path, body] of cases) {
      const response = await sendRequest(port, { body, path });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(JSON.parse(response.body), { error: "bad-request" });
    }
    assert.equal(spawnCalls.length, 0);
  } finally {
    await close(server);
  }
});

test("enforces parameter count, range, and length limits", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const cases = [
      ["/vtd/list", { page: 10_001 }],
      ["/vtd/list", { pageSize: 101 }],
      ["/vtd/list", { botName: "a".repeat(4097) }],
      [
        "/vtd/slice-store",
        {
          id: "1234",
          topics: Array.from({ length: 201 }, (_, index) => `/topic${index}`),
        },
      ],
    ];
    for (const [path, body] of cases) {
      const response = await sendRequest(port, { body, path });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(JSON.parse(response.body), { error: "bad-request" });
    }
    assert.equal(spawnCalls.length, 0);
  } finally {
    await close(server);
  }
});

test("does not expose local-output, download, or GUI flags", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const cases = [
      ["/vtd/url", { id: "1234", save: true }],
      ["/vtd/url", { foxglove: true, id: "1234" }],
      ["/vtd/slice-get", { out: "/tmp/result", sliceId: "slice-1" }],
      ["/vtd/trigger", { download: "all", triggerId: "trigger-1" }],
      ["/vtd/download", { id: "1234" }],
    ];
    for (const [path, body] of cases) {
      const response = await sendRequest(port, { body, path });
      assert.ok([400, 404].includes(response.statusCode));
      assert.deepEqual(JSON.parse(response.body), { error: "bad-request" });
    }
    assert.equal(spawnCalls.length, 0);
  } finally {
    await close(server);
  }
});

test("requires POST and application/json for command execution", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const wrongMethod = await sendRequest(port, {
      method: "GET",
      path: "/vtd/list",
    });
    assert.equal(wrongMethod.statusCode, 405);

    const missingContentType = await sendRequest(port, {
      contentType: undefined,
      path: "/vtd/list",
      rawBody: "{}",
    });
    assert.equal(missingContentType.statusCode, 415);

    const formContentType = await sendRequest(port, {
      contentType: "text/plain",
      path: "/vtd/list",
      rawBody: "{}",
    });
    assert.equal(formContentType.statusCode, 415);
    assert.equal(spawnCalls.length, 0);
  } finally {
    await close(server);
  }
});

test("rejects request bodies larger than 1 MiB before spawning", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const response = await sendRequest(port, {
      contentType: "application/json",
      path: "/vtd/list",
      rawBody: `"${"x".repeat(1024 * 1024)}"`,
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(JSON.parse(response.body), { error: "bad-request" });
    assert.equal(spawnCalls.length, 0);
  } finally {
    await close(server);
  }
});

test("authenticates configured Bearer tokens before spawning", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    authToken: "test-secret",
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);

  try {
    const missing = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(missing.statusCode, 401);

    const wrong = await sendRequest(port, {
      body: {},
      headers: { Authorization: "Bearer wrong-secret" },
      path: "/vtd/list",
    });
    assert.equal(wrong.statusCode, 401);

    const wrongSameLength = await sendRequest(port, {
      body: {},
      headers: { Authorization: "Bearer best-secret" },
      path: "/vtd/list",
    });
    assert.equal(wrongSameLength.statusCode, 401);

    const accepted = await sendRequest(port, {
      body: {},
      headers: { Authorization: "Bearer test-secret" },
      path: "/vtd/list",
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(spawnCalls.length, 1);
  } finally {
    await close(server);
  }
});

test("defaults to no CORS headers and supports explicit preflight configuration", async () => {
  const defaultServer = createVtdSidecarServer({
    spawnImpl: () => createMockChild(),
  });
  const defaultPort = await listen(defaultServer);
  try {
    const health = await sendRequest(defaultPort, {
      method: "GET",
      path: "/healthz",
    });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["access-control-allow-origin"], undefined);
  } finally {
    await close(defaultServer);
  }

  const corsServer = createVtdSidecarServer({
    allowOrigin: "https://lichtblick.example",
    authToken: "cors-secret",
    spawnImpl: () => createMockChild(),
  });
  const corsPort = await listen(corsServer);
  try {
    const response = await sendRequest(corsPort, {
      headers: { Origin: "https://lichtblick.example" },
      method: "OPTIONS",
      path: "/vtd/list",
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], "https://lichtblick.example");
    assert.equal(response.headers["access-control-allow-methods"], "POST, OPTIONS");
    assert.equal(response.headers["access-control-allow-headers"], "Content-Type, Authorization");

    const rejected = await sendRequest(corsPort, {
      body: {},
      headers: { Origin: "https://evil.example" },
      path: "/vtd/list",
    });
    assert.equal(rejected.statusCode, 403);
  } finally {
    await close(corsServer);
  }
});

test("occupies a CLI slot only after a complete request body", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    concurrencyLimit: 1,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);
  const slow = openSlowJsonRequest(port, "/vtd/list");

  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const competing = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(competing.statusCode, 200);
    assert.equal(spawnCalls.length, 1);

    slow.request.end("}");
    const completed = await slow.responsePromise;
    assert.equal(completed.statusCode, 200);
    assert.equal(spawnCalls.length, 2);
  } finally {
    slow.request.destroy();
    await close(server);
  }
});

test("bounds incomplete request bodies with a separate synchronous counter", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    pendingBodyLimit: 1,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);
  const slow = openSlowJsonRequest(port, "/vtd/list");

  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const competing = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(competing.statusCode, 429);
    assert.equal(spawnCalls.length, 0);

    slow.request.end("}");
    const completed = await slow.responsePromise;
    assert.equal(completed.statusCode, 200);
    assert.equal(spawnCalls.length, 1);
  } finally {
    slow.request.destroy();
    await close(server);
  }
});

test("times out incomplete bodies and releases the pending-body capacity", async () => {
  const spawnCalls = [];
  const server = createVtdSidecarServer({
    bodyTimeoutMs: 20,
    pendingBodyLimit: 1,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return createMockChild();
    },
  });
  const port = await listen(server);
  const slow = openSlowJsonRequest(port, "/vtd/list");

  try {
    const timedOut = await slow.responsePromise;
    assert.equal(timedOut.statusCode, 408);
    assert.deepEqual(JSON.parse(timedOut.body), { error: "timeout" });
    assert.equal(spawnCalls.length, 0);
    slow.request.destroy();

    const afterTimeout = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(afterTimeout.statusCode, 200);
    assert.equal(spawnCalls.length, 1);
  } finally {
    slow.request.destroy();
    await close(server);
  }
});

test("uses SIGTERM then SIGKILL and retains the slot until close", async () => {
  const timedOutChild = createMockChild({ autoClose: false });
  let spawnCount = 0;
  const server = createVtdSidecarServer({
    concurrencyLimit: 1,
    killGraceMs: 20,
    spawnImpl: () => {
      spawnCount += 1;
      return spawnCount === 1 ? timedOutChild : createMockChild();
    },
    timeoutMs: 10,
  });
  const port = await listen(server);
  const firstResponsePromise = sendRequest(port, {
    body: { id: "1234" },
    path: "/vtd/detail",
  });

  try {
    await waitFor(() => timedOutChild.killCalls.includes("SIGTERM"));
    const duringTermination = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(duringTermination.statusCode, 429);

    await waitFor(() => timedOutChild.killCalls.includes("SIGKILL"));
    const afterSigkillBeforeClose = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(afterSigkillBeforeClose.statusCode, 429);

    timedOutChild.finish(null, "SIGKILL");
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.statusCode, 504);
    assert.deepEqual(JSON.parse(firstResponse.body), { error: "timeout" });
    assert.deepEqual(timedOutChild.killCalls, ["SIGTERM", "SIGKILL"]);

    const afterClose = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(afterClose.statusCode, 200);
  } finally {
    timedOutChild.finish(null, "SIGKILL");
    await firstResponsePromise.catch(() => undefined);
    await close(server);
  }
});

test("retains a leaked child's slot until a late close event", async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...values) => {
    logged.push(values.join(" "));
  };
  const leakedChild = createMockChild({
    autoClose: false,
    killReturn: false,
  });
  let spawnCount = 0;
  const server = createVtdSidecarServer({
    concurrencyLimit: 1,
    killGraceMs: 10,
    leakGraceMs: 10,
    spawnImpl: () => {
      spawnCount += 1;
      return spawnCount === 1 ? leakedChild : createMockChild();
    },
    timeoutMs: 10,
  });
  const port = await listen(server);

  try {
    const timedOut = await sendRequest(port, {
      body: { id: "1234" },
      path: "/vtd/detail",
    });
    assert.equal(timedOut.statusCode, 504);
    assert.deepEqual(JSON.parse(timedOut.body), { error: "timeout" });
    assert.deepEqual(leakedChild.killCalls, ["SIGTERM", "SIGKILL"]);
    assert.match(logged.join("\n"), /process marked leaked/);

    const afterLeakDeadline = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(afterLeakDeadline.statusCode, 429);
    assert.equal(spawnCount, 1);

    leakedChild.finish(null, "SIGKILL");
    const afterLateClose = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(afterLateClose.statusCode, 200);
    assert.equal(spawnCount, 2);
  } finally {
    console.error = originalConsoleError;
    leakedChild.finish(null, "SIGKILL");
    await close(server);
  }
});

test("terminates an active child when the HTTP client disconnects", async () => {
  const activeChild = createMockChild({
    autoClose: false,
    closeOnSignal: "SIGTERM",
  });
  let spawnCount = 0;
  const server = createVtdSidecarServer({
    concurrencyLimit: 1,
    spawnImpl: () => {
      spawnCount += 1;
      return spawnCount === 1 ? activeChild : createMockChild();
    },
    timeoutMs: 1000,
  });
  const port = await listen(server);

  try {
    const request = httpRequest({
      headers: {
        "Content-Length": 13,
        "Content-Type": "application/json",
      },
      host: "127.0.0.1",
      method: "POST",
      path: "/vtd/detail",
      port,
    });
    request.on("error", () => {});
    request.end('{"id":"1234"}');
    await waitFor(() => spawnCount === 1);
    request.destroy();
    await waitFor(() => activeChild.killCalls.includes("SIGTERM"));
    await waitFor(() => activeChild.closed);

    const afterDisconnect = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(afterDisconnect.statusCode, 200);
    assert.equal(spawnCount, 2);
  } finally {
    activeChild.finish(null, "SIGTERM");
    await close(server);
  }
});

test("returns only classified upstream errors and honors MAX_OUTPUT_BYTES", async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...values) => {
    logged.push(values.join(" "));
  };
  const server = createVtdSidecarServer({
    maxOutputBytes: 4,
    spawnImpl: () =>
      createMockChild({
        stderr: "sensitive-upstream-details",
        stdout: '{"long":true}',
      }),
  });
  const port = await listen(server);

  try {
    const response = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body), { error: "upstream-error" });
    assert.doesNotMatch(response.body, /sensitive|configured|bytes/);
    assert.match(logged.join("\n"), /configured limit of 4 bytes/);
  } finally {
    console.error = originalConsoleError;
    await close(server);
  }
});

test("redacts credentials, request suffixes, TOS paths, and control characters from logs", async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...values) => {
    logged.push(values.join(" "));
  };
  const server = createVtdSidecarServer({
    spawnImpl: () =>
      createMockChild({
        code: 1,
        stderr:
          "Authorization: Bearer top-secret\r\nhttps://store.example/file.mcap?X-Amz-Signature=query-secret&token=also-secret\nhttps://user:password@internal.example/path#fragment-secret\ntos://private-bucket/robot-sn/path.mcap\nnext-line",
      }),
  });
  const port = await listen(server);

  try {
    const response = await sendRequest(port, {
      body: {},
      path: "/vtd/list",
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body), { error: "upstream-error" });
    const output = logged.join("\n");
    assert.match(output, /Bearer \[REDACTED\]/);
    assert.match(output, /file\.mcap\?\[REDACTED\]/);
    assert.match(output, /https:\/\/\[REDACTED\]@internal\.example\/path\?\[REDACTED\]/);
    assert.match(output, /tos:\/\/\[REDACTED\]/);
    assert.doesNotMatch(
      output,
      /top-secret|query-secret|also-secret|user:password|fragment-secret|private-bucket|robot-sn|path\.mcap|\r|\nnext-line/,
    );
  } finally {
    console.error = originalConsoleError;
    await close(server);
  }
});
