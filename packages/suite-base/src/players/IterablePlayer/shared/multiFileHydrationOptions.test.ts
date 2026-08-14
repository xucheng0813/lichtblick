// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { MultiIterableSource } from "./MultiIterableSource";
import {
  addMultiFileHydrationOverrides,
  pickDefinedHydrationOverrides,
} from "./multiFileHydrationOptions";
import { initialize } from "../Mcap/McapIterableSourceWorker.worker";

// Mocks for the worker-chain tests below (mirrors McapIterableSourceWorker.worker.test.ts): the
// worker's initialize() constructs MultiIterableSource with the picked hydration overrides.
jest.mock("@lichtblick/comlink", () => ({
  expose: jest.fn((val: unknown) => val),
  proxy: jest.fn((val: unknown) => val),
  transferHandlers: {
    set: jest.fn(),
  },
}));

jest.mock("../Mcap/McapIterableSource");
jest.mock("../WorkerSerializedIterableSourceWorker");
jest.mock("./MultiIterableSource");

const MockMultiIterableSource = MultiIterableSource as jest.Mock;

describe("multiFileHydrationOptions", () => {
  describe("addMultiFileHydrationOverrides", () => {
    it("returns initArgs unchanged when overrides are undefined", () => {
      // GIVEN: base init args with no override object.
      const initArgs = { files: [new File(["data"], "first.mcap")] };

      // WHEN: applying undefined overrides.
      const result = addMultiFileHydrationOverrides(initArgs, undefined);

      // THEN: the original init args object is returned unchanged.
      expect(result).toBe(initArgs);
    });

    it("merges a single defined override field", () => {
      // GIVEN: base init args and one defined override.
      const initArgs = { urls: ["https://example.com/first.mcap"] };

      // WHEN: applying the override.
      const result = addMultiFileHydrationOverrides(initArgs, {
        maxHydratedSources: 3,
      });

      // THEN: only the defined field is merged into the result.
      expect(result).toEqual({
        urls: ["https://example.com/first.mcap"],
        maxHydratedSources: 3,
      });
    });

    it("merges all defined override fields", () => {
      // GIVEN: base init args and all override fields defined.
      const initArgs = { files: [new File(["data"], "first.mcap")] };

      // WHEN: applying the overrides.
      const result = addMultiFileHydrationOverrides(initArgs, {
        maxHydratedSources: 4,
        maxHydratedBytes: 5678,
        initConcurrency: 2,
        prewarmCount: 0,
        readAheadBufferBytes: 12345,
        parallelConnections: 4,
      });

      // THEN: every defined override field is merged into the result.
      expect(result).toEqual({
        files: [initArgs.files[0]],
        maxHydratedSources: 4,
        maxHydratedBytes: 5678,
        initConcurrency: 2,
        prewarmCount: 0,
        readAheadBufferBytes: 12345,
        parallelConnections: 4,
      });
    });

    it("preserves an explicit parallelConnections of 1 (parallel downloads disabled)", () => {
      // GIVEN: base init args and a single-connection parallelConnections override.
      const initArgs = { urls: ["https://example.com/first.mcap"] };

      // WHEN: applying the override.
      const result = addMultiFileHydrationOverrides(initArgs, {
        parallelConnections: 1,
      });

      // THEN: the explicit 1 is preserved (it must not be mistaken for "unset").
      expect(result).toEqual({
        urls: ["https://example.com/first.mcap"],
        parallelConnections: 1,
      });
    });

    it("merges prewarmCount and readAheadBufferBytes with their exact values including explicit 0", () => {
      // GIVEN: base init args and only the new tuning fields defined.
      const initArgs = { urls: ["https://example.com/first.mcap"] };

      // WHEN: applying the overrides.
      const result = addMultiFileHydrationOverrides(initArgs, {
        prewarmCount: 0,
        readAheadBufferBytes: 262144,
      });

      // THEN: the exact values (including 0 for prewarmCount) are preserved.
      expect(result).toEqual({
        urls: ["https://example.com/first.mcap"],
        prewarmCount: 0,
        readAheadBufferBytes: 262144,
      });
    });

    it("does not add undefined override fields or overwrite existing values with undefined", () => {
      // GIVEN: init args that already include hydration fields.
      const initArgs = {
        urls: ["https://example.com/first.mcap"],
        maxHydratedSources: 9,
        initConcurrency: 5,
      };

      // WHEN: applying an override object with mixed defined and undefined values.
      const result = addMultiFileHydrationOverrides(initArgs, {
        maxHydratedSources: undefined,
        maxHydratedBytes: 1234,
        initConcurrency: undefined,
      });

      // THEN: only the defined override is applied and existing values remain intact.
      expect(result).toEqual({
        urls: ["https://example.com/first.mcap"],
        maxHydratedSources: 9,
        maxHydratedBytes: 1234,
        initConcurrency: 5,
      });
    });
  });

  describe("pickDefinedHydrationOverrides", () => {
    it("returns only the defined hydration fields", () => {
      // GIVEN: a mixed hydration override object.
      const overrides = {
        maxHydratedSources: 4,
        maxHydratedBytes: undefined,
        initConcurrency: 2,
      };

      // WHEN: picking defined fields.
      const result = pickDefinedHydrationOverrides(overrides);

      // THEN: only the defined fields are returned.
      expect(result).toEqual({
        maxHydratedSources: 4,
        initConcurrency: 2,
      });
    });

    it("carries prewarmCount (including explicit 0) and readAheadBufferBytes when defined", () => {
      // GIVEN: an override object with the new tuning fields, one of them 0.
      const overrides = {
        prewarmCount: 0,
        readAheadBufferBytes: 12345,
      };

      // WHEN: picking defined fields.
      const result = pickDefinedHydrationOverrides(overrides);

      // THEN: exact values are preserved; an explicit 0 disables prewarm and must survive.
      expect(result).toEqual({
        prewarmCount: 0,
        readAheadBufferBytes: 12345,
      });
    });

    it("carries parallelConnections (including explicit 0 and 1) when defined", () => {
      // GIVEN: override objects with parallelConnections set to an explicit value.
      // WHEN/THEN: exact values are preserved at both ends of the range.
      expect(
        pickDefinedHydrationOverrides({ parallelConnections: 0 }),
      ).toEqual({ parallelConnections: 0 });
      expect(
        pickDefinedHydrationOverrides({ parallelConnections: 1 }),
      ).toEqual({ parallelConnections: 1 });
      expect(
        pickDefinedHydrationOverrides({ parallelConnections: 4 }),
      ).toEqual({ parallelConnections: 4 });
    });

    it("omits undefined parallelConnections", () => {
      // GIVEN: an override object where parallelConnections is not defined.
      const overrides = {
        parallelConnections: undefined,
      };

      // WHEN: picking defined fields.
      const result = pickDefinedHydrationOverrides(overrides);

      // THEN: the field does not appear in the result.
      expect(result).toEqual({});
    });

    it("omits undefined prewarmCount and readAheadBufferBytes", () => {
      // GIVEN: an override object where the new tuning fields are not defined.
      const overrides = {
        prewarmCount: undefined,
        readAheadBufferBytes: undefined,
      };

      // WHEN: picking defined fields.
      const result = pickDefinedHydrationOverrides(overrides);

      // THEN: neither field appears in the result.
      expect(result).toEqual({});
    });
  });
});

describe("worker initialize chain (args -> pickDefinedHydrationOverrides -> MultiIterableSource)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("passes prewarmCount and readAheadBufferBytes through to MultiIterableSource for multiple urls", () => {
    initialize({
      urls: ["https://example.com/a.mcap", "https://example.com/b.mcap"],
      prewarmCount: 0,
      readAheadBufferBytes: 262144,
      maxHydratedSources: 3,
    });

    expect(MockMultiIterableSource).toHaveBeenCalledWith(
      {
        type: "urls",
        urls: ["https://example.com/a.mcap", "https://example.com/b.mcap"],
        prewarmCount: 0,
        readAheadBufferBytes: 262144,
        maxHydratedSources: 3,
      },
      expect.any(Function),
    );
  });

  it("passes an explicit parallelConnections through to MultiIterableSource for multiple urls", () => {
    initialize({
      urls: ["https://example.com/a.mcap", "https://example.com/b.mcap"],
      parallelConnections: 2,
    });

    expect(MockMultiIterableSource).toHaveBeenCalledWith(
      {
        type: "urls",
        urls: ["https://example.com/a.mcap", "https://example.com/b.mcap"],
        parallelConnections: 2,
      },
      expect.any(Function),
    );
  });

  it("leaves prewarmCount and readAheadBufferBytes undefined for multiple urls when not configured", () => {
    initialize({ urls: ["https://example.com/a.mcap", "https://example.com/b.mcap"] });

    expect(MockMultiIterableSource).toHaveBeenCalledWith(
      {
        type: "urls",
        urls: ["https://example.com/a.mcap", "https://example.com/b.mcap"],
      },
      expect.any(Function),
    );
  });
});
