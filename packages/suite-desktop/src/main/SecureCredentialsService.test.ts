// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { SafeStorage } from "electron";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import SecureCredentialsService from "./SecureCredentialsService";

type SafeStorageApi = Pick<
  SafeStorage,
  | "decryptString"
  | "encryptString"
  | "getSelectedStorageBackend"
  | "isEncryptionAvailable"
>;

function fakeSafeStorage(): SafeStorageApi {
  return {
    decryptString: jest.fn((encrypted) => {
      const encoded = encrypted.toString("utf8");
      if (!encoded.startsWith("encrypted:")) {
        throw new Error("invalid ciphertext");
      }
      return Buffer.from(encoded.slice("encrypted:".length), "base64").toString(
        "utf8",
      );
    }),
    encryptString: jest.fn((value) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    ),
    getSelectedStorageBackend: jest.fn(() => "gnome_libsecret"),
    isEncryptionAvailable: jest.fn(() => true),
  };
}

function encryptedValue(value: string): string {
  return Buffer.from(
    `encrypted:${Buffer.from(value).toString("base64")}`,
  ).toString("base64");
}

function serializeTestValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized == undefined) {
    throw new Error("Unable to serialize test value");
  }
  return serialized;
}

describe("SecureCredentialsService", () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "lichtblick-credentials-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { force: true, recursive: true });
  });

  it("encrypts values at rest and preserves concurrent writes", async () => {
    const safeStorage = fakeSafeStorage();
    const service = new SecureCredentialsService({ safeStorage, userDataPath });

    await expect(
      Promise.all([
        service.set("agent.llmApiKey", "llm-secret"),
        service.set("agent.vtdAuthToken", "vtd-secret"),
      ]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);

    const contents = await readFile(
      join(userDataPath, "agent-credentials.json"),
      "utf8",
    );
    expect(contents).not.toContain("llm-secret");
    expect(contents).not.toContain("vtd-secret");
    expect(JSON.parse(contents)).toEqual({
      credentials: {
        "agent.llmApiKey": {
          backend: "gnome_libsecret",
          ciphertext: encryptedValue("llm-secret"),
        },
        "agent.vtdAuthToken": {
          backend: "gnome_libsecret",
          ciphertext: encryptedValue("vtd-secret"),
        },
      },
      version: 2,
    });
    await expect(service.get("agent.llmApiKey")).resolves.toEqual({
      ok: true,
      value: "llm-secret",
    });
    await expect(service.get("agent.vtdAuthToken")).resolves.toEqual({
      ok: true,
      value: "vtd-secret",
    });
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(2);
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(2);
  });

  it("accepts bounded profile keys and rejects arbitrary or malformed keys", async () => {
    const service = new SecureCredentialsService({
      safeStorage: fakeSafeStorage(),
      userDataPath,
    });
    const profileKey = "agent.profile.profile-123.llmApiKey";

    await expect(service.set(profileKey, "profile-secret")).resolves.toEqual({
      ok: true,
    });
    await expect(service.get(profileKey)).resolves.toEqual({
      ok: true,
      value: "profile-secret",
    });
    await expect(
      service.set("agent.profile.bad_id.llmApiKey", "secret"),
    ).rejects.toThrow("Unsupported secure credential key");
    await expect(
      service.set(`agent.profile.${"a".repeat(65)}.llmApiKey`, "secret"),
    ).rejects.toThrow("Unsupported secure credential key");
    await expect(
      service.get("agent.profile.profile-123.unrelated"),
    ).rejects.toThrow("Unsupported secure credential key");
    await expect(
      service.setMany([
        {
          key: "unrelated.key",
          value: serializeTestValue({ revision: "R1" }),
        },
      ] as never),
    ).resolves.toEqual({ code: "invalid-request", ok: false });
  });

  it("rejects arbitrary keys already present in the credentials file", async () => {
    await writeFile(
      join(userDataPath, "agent-credentials.json"),
      serializeTestValue({
        credentials: {
          "agent.profile.bad_id.llmApiKey": {
            backend: "gnome_libsecret",
            ciphertext: encryptedValue("secret"),
          },
        },
        version: 2,
      }),
    );
    const service = new SecureCredentialsService({
      safeStorage: fakeSafeStorage(),
      userDataPath,
    });

    await expect(service.get("agent.llmApiKey")).rejects.toThrow(
      "Unable to read secure credentials",
    );
  });

  it("does not write any entry when a setMany entry is invalid or encryption fails", async () => {
    const safeStorage = fakeSafeStorage();
    const service = new SecureCredentialsService({ safeStorage, userDataPath });
    await service.setMany([
      {
        key: "agent.llmApiKey",
        value: serializeTestValue({ revision: "R0", value: "old-llm" }),
      },
      {
        key: "agent.vtdAuthToken",
        value: serializeTestValue({ revision: "R0", value: "old-vtd" }),
      },
    ]);
    const credentialsPath = join(userDataPath, "agent-credentials.json");
    const contentsBefore = await readFile(credentialsPath, "utf8");

    await expect(
      service.setMany([
        {
          expectedRevision: "R0",
          key: "agent.llmApiKey",
          value: serializeTestValue({ revision: "R1", value: "new-llm" }),
        },
        {
          expectedRevision: "R0",
          key: "unsupported.key",
          value: serializeTestValue({ revision: "R1", value: "new-vtd" }),
        },
      ] as never),
    ).resolves.toEqual({ code: "invalid-request", ok: false });
    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(
      contentsBefore,
    );

    jest
      .mocked(safeStorage.encryptString)
      .mockImplementationOnce((value) =>
        Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
      )
      .mockImplementationOnce(() => {
        throw new Error("encryption failed");
      });
    await expect(
      service.setMany([
        {
          expectedRevision: "R0",
          key: "agent.llmApiKey",
          value: serializeTestValue({ revision: "R1", value: "new-llm" }),
        },
        {
          expectedRevision: "R0",
          key: "agent.vtdAuthToken",
          value: serializeTestValue({ revision: "R1", value: "new-vtd" }),
        },
      ]),
    ).rejects.toThrow("encryption failed");
    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(
      contentsBefore,
    );
  });

  it("allows only one concurrent setMany writer for an expected revision", async () => {
    const safeStorage = fakeSafeStorage();
    const service = new SecureCredentialsService({ safeStorage, userDataPath });
    await service.setMany([
      {
        key: "agent.llmApiKey",
        value: serializeTestValue({ revision: "R0", value: "old-llm" }),
      },
      {
        key: "agent.vtdAuthToken",
        value: serializeTestValue({ revision: "R0", value: "old-vtd" }),
      },
    ]);
    const makeEntries = (revision: string) => [
      {
        expectedRevision: "R0",
        key: "agent.llmApiKey" as const,
        value: serializeTestValue({ revision, value: `${revision}-llm` }),
      },
      {
        expectedRevision: "R0",
        key: "agent.vtdAuthToken" as const,
        value: serializeTestValue({ revision, value: `${revision}-vtd` }),
      },
    ];

    const results = await Promise.all([
      service.setMany(makeEntries("R1")),
      service.setMany(makeEntries("R2")),
    ]);

    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ code: "revision-conflict", ok: false });
    const llmResult = await service.get("agent.llmApiKey");
    const vtdResult = await service.get("agent.vtdAuthToken");
    expect(llmResult.ok).toBe(true);
    expect(vtdResult.ok).toBe(true);
    if (!llmResult.ok || !vtdResult.ok) {
      throw new Error("Expected stored credentials");
    }
    const llm = JSON.parse(llmResult.value ?? "") as { revision: string };
    const vtd = JSON.parse(vtdResult.value ?? "") as { revision: string };
    expect(["R1", "R2"]).toContain(llm.revision);
    expect(vtd.revision).toBe(llm.revision);
  });

  it("deletes individual credentials and removes the file when none remain", async () => {
    const service = new SecureCredentialsService({
      safeStorage: fakeSafeStorage(),
      userDataPath,
    });
    await service.set("agent.llmApiKey", "llm-secret");
    await service.set("agent.vtdAuthToken", "vtd-secret");

    await service.delete("agent.llmApiKey");
    await expect(service.get("agent.llmApiKey")).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(service.get("agent.vtdAuthToken")).resolves.toEqual({
      ok: true,
      value: "vtd-secret",
    });

    await service.delete("agent.vtdAuthToken");
    await expect(
      readFile(join(userDataPath, "agent-credentials.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not persist when encryption is unavailable or uses Linux basic_text", async () => {
    const unavailable = fakeSafeStorage();
    jest.mocked(unavailable.isEncryptionAvailable).mockReturnValue(false);
    const unavailableService = new SecureCredentialsService({
      safeStorage: unavailable,
      userDataPath,
    });

    await expect(unavailableService.set("other.key", "secret")).rejects.toThrow(
      "Unsupported secure credential key",
    );
    await expect(
      unavailableService.set("agent.llmApiKey", "secret"),
    ).resolves.toEqual({
      code: "backend-unavailable",
      ok: false,
    });
    expect(unavailable.encryptString).not.toHaveBeenCalled();

    const basicText = fakeSafeStorage();
    jest
      .mocked(basicText.getSelectedStorageBackend)
      .mockReturnValue("basic_text");
    const basicTextService = new SecureCredentialsService({
      safeStorage: basicText,
      userDataPath,
    });
    await expect(
      basicTextService.set("agent.vtdAuthToken", "secret"),
    ).resolves.toEqual({
      code: "insecure-backend",
      ok: false,
    });
    expect(basicText.encryptString).not.toHaveBeenCalled();
    await expect(
      readFile(join(userDataPath, "agent-credentials.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves secure records while the backend is temporarily unavailable", async () => {
    const safeStorage = fakeSafeStorage();
    const service = new SecureCredentialsService({ safeStorage, userDataPath });
    await service.set("agent.llmApiKey", "preserved-secret");
    const contentsBefore = await readFile(
      join(userDataPath, "agent-credentials.json"),
      "utf8",
    );

    jest.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    await expect(service.get("agent.llmApiKey")).resolves.toEqual({
      code: "backend-unavailable",
      ok: false,
    });
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
    await expect(
      readFile(join(userDataPath, "agent-credentials.json"), "utf8"),
    ).resolves.toBe(contentsBefore);

    jest.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
    await expect(service.get("agent.llmApiKey")).resolves.toEqual({
      ok: true,
      value: "preserved-secret",
    });
  });

  it("marks legacy records insecure when the current backend is basic_text", async () => {
    const safeStorage = fakeSafeStorage();
    jest
      .mocked(safeStorage.getSelectedStorageBackend)
      .mockReturnValue("basic_text");
    await writeFile(
      join(userDataPath, "agent-credentials.json"),
      serializeTestValue({
        credentials: {
          "agent.llmApiKey": encryptedValue("legacy-secret"),
        },
        version: 1,
      }),
    );
    const service = new SecureCredentialsService({ safeStorage, userDataPath });

    await expect(service.get("agent.llmApiKey")).resolves.toEqual({
      code: "insecure-backend",
      ok: true,
      value: "legacy-secret",
    });
  });

  it("preserves an insecure marker when the current backend has become secure", async () => {
    const safeStorage = fakeSafeStorage();
    await writeFile(
      join(userDataPath, "agent-credentials.json"),
      serializeTestValue({
        credentials: {
          "agent.vtdAuthToken": {
            backend: "basic_text",
            ciphertext: encryptedValue("old-token"),
          },
        },
        version: 2,
      }),
    );
    const service = new SecureCredentialsService({ safeStorage, userDataPath });

    await expect(service.get("agent.vtdAuthToken")).resolves.toEqual({
      code: "insecure-backend",
      ok: true,
      value: "old-token",
    });
  });

  it("treats legacy records as secure when the current backend is secure", async () => {
    const safeStorage = fakeSafeStorage();
    await writeFile(
      join(userDataPath, "agent-credentials.json"),
      serializeTestValue({
        credentials: {
          "agent.llmApiKey": encryptedValue("legacy-secret"),
        },
        version: 1,
      }),
    );
    const service = new SecureCredentialsService({ safeStorage, userDataPath });

    await expect(service.get("agent.llmApiKey")).resolves.toEqual({
      ok: true,
      value: "legacy-secret",
    });
  });

  it("rejects corrupt storage", async () => {
    const safeStorage = fakeSafeStorage();
    const service = new SecureCredentialsService({ safeStorage, userDataPath });

    const corruptContents = JSON.stringify({
      credentials: { "agent.llmApiKey": "not-base64!" },
      version: 1,
    });
    if (corruptContents == undefined) {
      throw new Error("Unable to serialize test credentials");
    }
    await writeFile(
      join(userDataPath, "agent-credentials.json"),
      corruptContents,
    );
    await expect(service.get("agent.llmApiKey")).rejects.toThrow(
      "invalid ciphertext",
    );
  });
});
