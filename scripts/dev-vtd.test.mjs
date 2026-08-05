// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_ALLOW_ORIGIN,
  DEFAULT_INSTALL_URL,
  buildInstallCommands,
  findVtdBinary,
  installVtd,
  parseInstallUrl,
  resolveSidecarEnv,
  runVtdDev,
  withVtdBinaryOnPath,
  withLocalBinOnPath,
} from "./dev-vtd.mjs";

function createFakeChild(code = 0) {
  const child = new EventEmitter();
  child.kill = () => true;
  child.finish = (exitCode = code) => {
    child.emit("close", exitCode, null);
  };
  return child;
}

const silent = () => {};

test("findVtdBinary finds vtd in ~/.local/bin", () => {
  const localBin = path.join("/home/user", ".local", "bin", "vtd");
  const accessSyncImpl = (filePath) => {
    if (filePath !== localBin) {
      throw new Error("missing");
    }
  };
  const execFileSyncImpl = (command, args) => {
    assert.equal(command, localBin);
    assert.deepEqual(args, ["--version"]);
  };

  assert.equal(
    findVtdBinary({ homeDir: "/home/user", accessSyncImpl, execFileSyncImpl }),
    localBin,
  );
});

test("findVtdBinary finds vtd in /usr/local/bin and /opt/homebrew/bin", () => {
  for (const candidate of ["/usr/local/bin/vtd", "/opt/homebrew/bin/vtd"]) {
    const accessSyncImpl = (filePath) => {
      if (filePath !== candidate) {
        throw new Error("missing");
      }
    };
    const execFileSyncImpl = (command, args) => {
      assert.equal(command, candidate);
      assert.deepEqual(args, ["--version"]);
    };
    assert.equal(
      findVtdBinary({ homeDir: "/home/user", accessSyncImpl, execFileSyncImpl }),
      candidate,
    );
  }
});

test("findVtdBinary falls back to a PATH probe via `vtd --version`", () => {
  const accessSyncImpl = () => {
    throw new Error("missing");
  };
  const execFileSyncImpl = (command, args) => {
    assert.equal(command, "vtd");
    assert.deepEqual(args, ["--version"]);
  };
  assert.equal(
    findVtdBinary({ homeDir: "/home/user", accessSyncImpl, execFileSyncImpl }),
    "vtd",
  );
});

test("findVtdBinary returns undefined when vtd is not installed", () => {
  const accessSyncImpl = () => {
    throw new Error("not executable");
  };
  const execFileSyncImpl = () => {
    throw new Error("vtd: command not found");
  };
  assert.equal(
    findVtdBinary({ homeDir: "/home/user", accessSyncImpl, execFileSyncImpl }),
    undefined,
  );
});

test("findVtdBinary rejects a present candidate that cannot execute --version", () => {
  const localBin = "/home/user/.local/bin/vtd";
  const accessSyncImpl = (filePath) => {
    if (filePath !== localBin) {
      throw new Error("missing");
    }
  };
  const execFileSyncImpl = () => {
    throw new Error("not executable");
  };

  assert.equal(
    findVtdBinary({ homeDir: "/home/user", accessSyncImpl, execFileSyncImpl }),
    undefined,
  );
});

test("buildInstallCommands uses argv for separate curl and bash processes", () => {
  assert.deepEqual(buildInstallCommands(DEFAULT_INSTALL_URL, "/tmp/install.sh"), [
    {
      command: "curl",
      args: [
        "-fsSL",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        "--output",
        "/tmp/install.sh",
        DEFAULT_INSTALL_URL,
      ],
    },
    { command: "bash", args: ["/tmp/install.sh"] },
  ]);
});

test("parseInstallUrl rejects shell metacharacters, whitespace, and non-HTTP protocols", () => {
  for (const url of [
    "http://127.0.0.1:1/&/usr/bin/true",
    "https://mirror.example/install.sh;touch-pwned",
    "https://mirror.example/has space/install.sh",
    "file:///tmp/install.sh",
  ]) {
    assert.throws(() => parseInstallUrl(url), /VTD_INSTALL_URL/u);
  }
});

test("installVtd downloads first, then runs bash, and removes its temporary directory", () => {
  const spawnCalls = [];
  const removed = [];
  const spawnSyncImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { status: 0 };
  };

  assert.equal(
    installVtd({
      spawnSyncImpl,
      mkdtempSyncImpl: () => "/tmp/vtd-install-test",
      rmSyncImpl: (...args) => removed.push(args),
      log: silent,
      onError: silent,
    }),
    true,
  );
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0], {
    command: "curl",
    args: [
      "-fsSL",
      "--proto",
      "=http,https",
      "--proto-redir",
      "=http,https",
      "--output",
      "/tmp/vtd-install-test/install.sh",
      DEFAULT_INSTALL_URL,
    ],
    options: { stdio: "inherit" },
  });
  assert.deepEqual(spawnCalls[1], {
    command: "bash",
    args: ["/tmp/vtd-install-test/install.sh"],
    options: { stdio: "inherit" },
  });
  assert.deepEqual(removed, [
    ["/tmp/vtd-install-test", { force: true, recursive: true }],
  ]);
});

test("installVtd uses the VTD_INSTALL_URL environment variable override", (t) => {
  const original = process.env.VTD_INSTALL_URL;
  t.after(() => {
    if (original == undefined) {
      delete process.env.VTD_INSTALL_URL;
    } else {
      process.env.VTD_INSTALL_URL = original;
    }
  });
  process.env.VTD_INSTALL_URL = "http://10.0.0.5:8080/install/vtd-cli.sh";

  const spawnCalls = [];
  const spawnSyncImpl = (command, args) => {
    spawnCalls.push({ command, args });
    return { status: 0 };
  };

  assert.equal(
    installVtd({
      spawnSyncImpl,
      mkdtempSyncImpl: () => "/tmp/vtd-install-test",
      rmSyncImpl: silent,
      log: silent,
      onError: silent,
    }),
    true,
  );
  assert.equal(spawnCalls[0].command, "curl");
  assert.equal(spawnCalls[0].args.at(-1), "http://10.0.0.5:8080/install/vtd-cli.sh");
  assert.deepEqual(spawnCalls[1], {
    command: "bash",
    args: ["/tmp/vtd-install-test/install.sh"],
  });
});

test("installVtd does not run bash when curl fails", () => {
  const errors = [];
  const spawnCalls = [];
  const spawnSyncImpl = (command) => {
    spawnCalls.push(command);
    return { status: 17 };
  };

  assert.equal(
    installVtd({
      spawnSyncImpl,
      mkdtempSyncImpl: () => "/tmp/vtd-install-test",
      rmSyncImpl: silent,
      log: silent,
      onError: (message) => errors.push(message),
    }),
    false,
  );
  assert.deepEqual(spawnCalls, ["curl"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /下载失败/u);
});

test("installVtd rejects an unsafe URL before creating files or spawning", () => {
  let spawnCount = 0;
  let temporaryDirectoryCount = 0;
  const result = installVtd({
    vtdInstallUrl: "http://127.0.0.1:1/;touch-pwned",
    spawnSyncImpl: () => {
      spawnCount += 1;
      return { status: 0 };
    },
    mkdtempSyncImpl: () => {
      temporaryDirectoryCount += 1;
      return "/tmp/should-not-exist";
    },
    rmSyncImpl: silent,
    log: silent,
    onError: silent,
  });

  assert.equal(result, false);
  assert.equal(spawnCount, 0);
  assert.equal(temporaryDirectoryCount, 0);
});

test("resolveSidecarEnv defaults ALLOW_ORIGIN to the web dev server origin", () => {
  const env = resolveSidecarEnv({ FOO: "bar" });
  assert.equal(env.ALLOW_ORIGIN, DEFAULT_ALLOW_ORIGIN);
  assert.equal(env.FOO, "bar");
});

test("resolveSidecarEnv preserves an existing ALLOW_ORIGIN", () => {
  const env = resolveSidecarEnv({ ALLOW_ORIGIN: "http://localhost:3000" });
  assert.equal(env.ALLOW_ORIGIN, "http://localhost:3000");
});

test("resolveSidecarEnv prepends the resolved non-standard vtd directory to PATH", () => {
  const env = resolveSidecarEnv(
    { ALLOW_ORIGIN: "http://localhost:3000", PATH: "/usr/bin:/bin" },
    "/srv/vtd-tools/bin/vtd",
  );
  assert.equal(env.PATH, "/srv/vtd-tools/bin:/usr/bin:/bin");
});

test("withVtdBinaryOnPath does not duplicate the resolved binary directory", () => {
  assert.equal(
    withVtdBinaryOnPath("/srv/vtd-tools/bin/vtd", {
      PATH: "/usr/bin:/srv/vtd-tools/bin:/bin",
    }),
    "/srv/vtd-tools/bin:/usr/bin:/bin",
  );
});

test("withLocalBinOnPath prepends ~/.local/bin without duplicates", () => {
  const env = { PATH: "/usr/bin:/opt/homebrew/bin:/Users/user/.local/bin:/usr/local/bin" };
  const result = withLocalBinOnPath({ homeDir: "/Users/user", env });
  assert.equal(result, "/Users/user/.local/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin");
});

test("runVtdDev skips the install when vtd is already installed", async () => {
  const child = createFakeChild(0);
  const calls = { install: 0, sidecar: 0, forward: 0 };
  let sidecarOptions;
  const pending = runVtdDev({
    findVtdBinaryImpl: () => "/srv/vtd-tools/bin/vtd",
    installVtdImpl: () => {
      calls.install += 1;
      return true;
    },
    startSidecarImpl: (options) => {
      calls.sidecar += 1;
      sidecarOptions = options;
      return child;
    },
    prependLocalBinImpl: () => {
      calls.install += 1;
      return process.env.PATH ?? "";
    },
    forwardSignalsImpl: () => {
      calls.forward += 1;
    },
    log: silent,
    onError: silent,
  });

  assert.equal(calls.install, 0);
  assert.equal(calls.sidecar, 1);
  assert.equal(calls.forward, 1);
  assert.equal(sidecarOptions.env.PATH.split(path.delimiter)[0], "/srv/vtd-tools/bin");

  child.finish(0);
  assert.equal(await pending, 0);
});

test("runVtdDev installs vtd when missing, re-checks, then starts the sidecar", async () => {
  const child = createFakeChild(0);
  const calls = { find: 0, install: 0, sidecar: 0, prepend: 0 };
  const pending = runVtdDev({
    findVtdBinaryImpl: () => {
      calls.find += 1;
      return calls.find === 1 ? undefined : "/Users/user/.local/bin/vtd";
    },
    installVtdImpl: () => {
      calls.install += 1;
      return true;
    },
    startSidecarImpl: () => {
      calls.sidecar += 1;
      return child;
    },
    prependLocalBinImpl: () => {
      calls.prepend += 1;
      return "/Users/user/.local/bin:/usr/bin";
    },
    forwardSignalsImpl: silent,
    log: silent,
    onError: silent,
  });

  assert.equal(calls.install, 1);
  assert.equal(calls.prepend, 1);
  assert.equal(calls.find, 2);
  assert.equal(calls.sidecar, 1);

  child.finish(0);
  assert.equal(await pending, 0);
});

test("runVtdDev exits with code 1 and no sidecar when the install fails", async () => {
  const calls = { sidecar: 0, errors: 0 };
  const code = await runVtdDev({
    findVtdBinaryImpl: () => undefined,
    installVtdImpl: () => false,
    startSidecarImpl: () => {
      calls.sidecar += 1;
      return createFakeChild(0);
    },
    prependLocalBinImpl: () => process.env.PATH ?? "",
    forwardSignalsImpl: silent,
    log: silent,
    onError: () => {
      calls.errors += 1;
    },
  });

  assert.equal(code, 1);
  assert.equal(calls.sidecar, 0);
  assert.equal(calls.errors, 1);
});
