// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Builder, ByteBuffer } from "flatbuffers";
import { BaseType, Parser, Schema, Type } from "flatbuffers_reflection";
import fs from "fs";

import { ByteVector } from "./fixtures/byte-vector";
import { parseFlatbufferSchema } from "./parseFlatbufferSchema";

const enumSchema = {
  definitions: [
    {
      isArray: true,
      isComplex: true,
      name: "attributes",
      type: "reflection.KeyValue",
    },
    {
      name: "declaration_file",
      type: "string",
    },
    {
      isArray: true,
      name: "documentation",
      type: "string",
    },
    {
      name: "is_union",
      type: "bool",
    },
    {
      name: "name",
      type: "string",
    },
    {
      isComplex: true,
      name: "underlying_type",
      type: "reflection.Type",
    },
    {
      isArray: true,
      isComplex: true,
      name: "values",
      type: "reflection.EnumVal",
    },
  ],
};
const typeSchema = {
  definitions: [
    {
      name: "base_size",
      type: "uint32",
    },
    {
      isConstant: true,
      name: "None",
      type: "int8",
      value: 0n,
    },
    {
      isConstant: true,
      name: "UType",
      type: "int8",
      value: 1n,
    },
    {
      isConstant: true,
      name: "Bool",
      type: "int8",
      value: 2n,
    },
    {
      isConstant: true,
      name: "Byte",
      type: "int8",
      value: 3n,
    },
    {
      isConstant: true,
      name: "UByte",
      type: "int8",
      value: 4n,
    },
    {
      isConstant: true,
      name: "Short",
      type: "int8",
      value: 5n,
    },
    {
      isConstant: true,
      name: "UShort",
      type: "int8",
      value: 6n,
    },
    {
      isConstant: true,
      name: "Int",
      type: "int8",
      value: 7n,
    },
    {
      isConstant: true,
      name: "UInt",
      type: "int8",
      value: 8n,
    },
    {
      isConstant: true,
      name: "Long",
      type: "int8",
      value: 9n,
    },
    {
      isConstant: true,
      name: "ULong",
      type: "int8",
      value: 10n,
    },
    {
      isConstant: true,
      name: "Float",
      type: "int8",
      value: 11n,
    },
    {
      isConstant: true,
      name: "Double",
      type: "int8",
      value: 12n,
    },
    {
      isConstant: true,
      name: "String",
      type: "int8",
      value: 13n,
    },
    {
      isConstant: true,
      name: "Vector",
      type: "int8",
      value: 14n,
    },
    {
      isConstant: true,
      name: "Obj",
      type: "int8",
      value: 15n,
    },
    {
      isConstant: true,
      name: "Union",
      type: "int8",
      value: 16n,
    },
    {
      isConstant: true,
      name: "Array",
      type: "int8",
      value: 17n,
    },
    {
      isConstant: true,
      name: "MaxBaseType",
      type: "int8",
      value: 18n,
    },
    {
      name: "base_type",
      type: "int8",
    },
    {
      isConstant: true,
      name: "None",
      type: "int8",
      value: 0n,
    },
    {
      isConstant: true,
      name: "UType",
      type: "int8",
      value: 1n,
    },
    {
      isConstant: true,
      name: "Bool",
      type: "int8",
      value: 2n,
    },
    {
      isConstant: true,
      name: "Byte",
      type: "int8",
      value: 3n,
    },
    {
      isConstant: true,
      name: "UByte",
      type: "int8",
      value: 4n,
    },
    {
      isConstant: true,
      name: "Short",
      type: "int8",
      value: 5n,
    },
    {
      isConstant: true,
      name: "UShort",
      type: "int8",
      value: 6n,
    },
    {
      isConstant: true,
      name: "Int",
      type: "int8",
      value: 7n,
    },
    {
      isConstant: true,
      name: "UInt",
      type: "int8",
      value: 8n,
    },
    {
      isConstant: true,
      name: "Long",
      type: "int8",
      value: 9n,
    },
    {
      isConstant: true,
      name: "ULong",
      type: "int8",
      value: 10n,
    },
    {
      isConstant: true,
      name: "Float",
      type: "int8",
      value: 11n,
    },
    {
      isConstant: true,
      name: "Double",
      type: "int8",
      value: 12n,
    },
    {
      isConstant: true,
      name: "String",
      type: "int8",
      value: 13n,
    },
    {
      isConstant: true,
      name: "Vector",
      type: "int8",
      value: 14n,
    },
    {
      isConstant: true,
      name: "Obj",
      type: "int8",
      value: 15n,
    },
    {
      isConstant: true,
      name: "Union",
      type: "int8",
      value: 16n,
    },
    {
      isConstant: true,
      name: "Array",
      type: "int8",
      value: 17n,
    },
    {
      isConstant: true,
      name: "MaxBaseType",
      type: "int8",
      value: 18n,
    },
    {
      name: "element",
      type: "int8",
    },
    {
      name: "element_size",
      type: "uint32",
    },
    {
      name: "fixed_length",
      type: "uint16",
    },
    {
      name: "index",
      type: "int32",
    },
  ],
};

const UnionType = {
  NONE: 0,
  TableA: 1,
  TableB: 2,
} as const;

type UnionMember =
  | {
      type: typeof UnionType.TableA;
      shared: number;
      conflict: number;
      aOnly: string;
    }
  | {
      type: typeof UnionType.TableB;
      shared: number;
      conflict: string;
      bOnly: boolean;
    };

function createUnionMember(builder: Builder, member: UnionMember): number {
  if (member.type === UnionType.TableA) {
    const aOnly = builder.createString(member.aOnly);
    builder.startObject(3);
    builder.addFieldInt32(0, member.shared, 0);
    builder.addFieldInt32(1, member.conflict, 0);
    builder.addFieldOffset(2, aOnly, 0);
    return builder.endObject();
  }

  const conflict = builder.createString(member.conflict);
  builder.startObject(3);
  builder.addFieldInt32(0, member.shared, 0);
  builder.addFieldOffset(1, conflict, 0);
  builder.addFieldInt8(2, member.bOnly ? 1 : 0, 0);
  return builder.endObject();
}

function createUnionTypeVector(builder: Builder, members: (UnionMember | undefined)[]): number {
  builder.startVector(1, members.length, 1);
  for (let index = members.length - 1; index >= 0; --index) {
    builder.addInt8(members[index]?.type ?? UnionType.NONE);
  }
  return builder.endVector();
}

function createUnionValueVector(builder: Builder, offsets: number[]): number {
  builder.startVector(4, offsets.length, 4);
  for (let index = offsets.length - 1; index >= 0; --index) {
    const offset = offsets[index] ?? 0;
    if (offset === 0) {
      builder.addInt32(0);
    } else {
      builder.addOffset(offset);
    }
  }
  return builder.endVector();
}

function createStructWithArray(builder: Builder, values: readonly number[]): number {
  if (values.length !== 4) {
    throw new Error("StructWithArray requires exactly four values.");
  }
  builder.prep(4, 16);
  for (let index = values.length - 1; index >= 0; --index) {
    builder.writeFloat32(values[index] ?? 0);
  }
  return builder.offset();
}

function buildUnionArrayMessage(options: {
  u?: UnionMember;
  us: (UnionMember | undefined)[];
  arr: readonly number[];
  plain: number;
}): Uint8Array {
  const builder = new Builder();
  const uOffset = options.u == undefined ? 0 : createUnionMember(builder, options.u);
  const usOffsets = options.us.map((member) =>
    member == undefined ? 0 : createUnionMember(builder, member),
  );
  const usType = createUnionTypeVector(builder, options.us);
  const us = createUnionValueVector(builder, usOffsets);
  const struct = createStructWithArray(builder, options.arr);

  builder.startObject(6);
  // Structs must be added before any other root field so they remain inline.
  builder.addFieldStruct(4, struct, 0);
  builder.addFieldInt8(0, options.u?.type ?? UnionType.NONE, UnionType.NONE);
  builder.addFieldOffset(1, uOffset, 0);
  builder.addFieldOffset(2, usType, 0);
  builder.addFieldOffset(3, us, 0);
  builder.addFieldInt32(5, options.plain, 0);
  builder.finish(builder.endObject());
  return Uint8Array.from(builder.asUint8Array());
}

describe("parseFlatbufferSchema", () => {
  const reflectionSchemaBuffer: Buffer = fs.readFileSync(`${__dirname}/fixtures/reflection.bfbs`);
  const reflectionSchemaUint8 = new Uint8Array(
    reflectionSchemaBuffer.buffer,
    reflectionSchemaBuffer.byteOffset,
    reflectionSchemaBuffer.byteLength,
  );

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("rejects invalid schema", () => {
    expect(() => parseFlatbufferSchema("test", new Uint8Array([1]))).toThrow();
  });
  it("parses root table schema", () => {
    // Use the reflection Schema itself to read the reflection Schema (this is
    // actually a pretty good test case for coverage, since the Schema message
    // includes almost all the various flatbuffer features).
    // The .bfbs file in question is generated from running
    // $ flatc -b --schema reflection/reflection.fbs
    // In https://github.com/google/flatbuffers
    const { datatypes, deserialize } = parseFlatbufferSchema(
      "reflection.Schema",
      reflectionSchemaUint8,
    );
    const deserialized: any = deserialize(reflectionSchemaBuffer);
    const reflectionSchemaByteBuffer: ByteBuffer = new ByteBuffer(reflectionSchemaUint8);
    const schema = Schema.getRootAsSchema(reflectionSchemaByteBuffer);
    // Spot check individual components to ensure that they got deserialized correctly.
    expect(deserialized.objects.length).toEqual(schema.objectsLength());
    expect(deserialized.objects.length).toEqual(10);
    expect(deserialized.objects[0].name).toEqual("reflection.Enum");
    expect(deserialized.file_ident).toEqual("BFBS");
    expect(deserialized.file_ext).toEqual("bfbs");
    expect(deserialized.fbs_files[0].filename.substr(-14)).toEqual("reflection.fbs");
    // Spot check the datatypes list.
    expect(datatypes.keys()).toContain("reflection.Enum");
    expect(datatypes.keys()).toContain("reflection.Object");
    expect(datatypes.get("reflection.Enum")).toEqual(enumSchema);
  });
  it("parses non-root table schema", () => {
    const { datatypes, deserialize } = parseFlatbufferSchema(
      "reflection.Type",
      reflectionSchemaUint8,
    );
    expect(datatypes.keys()).toContain("reflection.Type");
    expect(datatypes.get("reflection.Type")).toEqual(typeSchema);

    // Construct a reflection.Type object from scratch and confirm that we get
    // exactly the correct result.
    const builder = new Builder();
    Type.startType(builder);
    Type.addBaseType(builder, BaseType.Int);
    Type.addIndex(builder, 123);
    builder.finish(Type.endType(builder));

    expect(deserialize(builder.asUint8Array())).toEqual({
      base_size: 4,
      base_type: 7,
      element: 0,
      element_size: 0,
      fixed_length: 0,
      index: 123,
    });
  });
  it("converts uint8 vectors to uint8arrays", () => {
    const builder = new Builder();

    /**
     * Byte Vector Schema (.fbs file not included in this repo)
     * table ByteVector {
     *   data:[uint8];
     * }
     * root_type ByteVector;
     */
    const data = ByteVector.createDataVector(builder, [1, 2, 3]);
    ByteVector.startByteVector(builder);
    ByteVector.addData(builder, data);
    const byteVector = ByteVector.endByteVector(builder);
    builder.finish(byteVector);
    /** the underlying buffer for the builder is larger than the uint8array of the data
     * this needs to be cleared so that the reading from the buffer by the parser doesn't use the wrong offsets
     * normally when this is written to a file, only the contents of the Uint8Array are written, not the underlying buffer
     * so this replicates that
     * essentially need to make sure byteVectorBin.buffer !== builder.asUint8Array().buffer
     */
    const byteVectorBin = Uint8Array.from(builder.asUint8Array());

    const byteVectorSchemaArray = fs.readFileSync(`${__dirname}/fixtures/ByteVector.bfbs`);
    const byteVectorSchemaArrayUint8 = new Uint8Array(
      byteVectorSchemaArray.buffer,
      byteVectorSchemaArray.byteOffset,
      byteVectorSchemaArray.byteLength,
    );
    const { deserialize } = parseFlatbufferSchema("ByteVector", byteVectorSchemaArrayUint8);
    expect(deserialize(byteVectorBin)).toEqual({ data: new Uint8Array([1, 2, 3]) });
  });

  describe("unions and fixed-length arrays", () => {
    // Generated from the fixtures directory with:
    // /opt/homebrew/bin/flatc -b --schema union-array.fbs
    const unionArraySchemaBuffer: Buffer = fs.readFileSync(
      `${__dirname}/fixtures/union-array.bfbs`,
    );
    const unionArraySchema = new Uint8Array(
      unionArraySchemaBuffer.buffer,
      unionArraySchemaBuffer.byteOffset,
      unionArraySchemaBuffer.byteLength,
    );

    it("maps union discriminators, synthesized union fields, and fixed array lengths", () => {
      const { datatypes } = parseFlatbufferSchema("UnionArray.Root", unionArraySchema);

      expect(datatypes.get("UnionArray.Root")?.definitions).toEqual([
        { name: "plain", type: "int32" },
        { name: "s", type: "UnionArray.StructWithArray", isComplex: true },
        { name: "NONE", type: "uint8", isConstant: true, value: 0n },
        { name: "TableA", type: "uint8", isConstant: true, value: 1n },
        { name: "TableB", type: "uint8", isConstant: true, value: 2n },
        { name: "u_type", type: "uint8" },
        { name: "u", type: "UnionArray.U", isComplex: true },
        { name: "NONE", type: "uint8", isConstant: true, value: 0n },
        { name: "TableA", type: "uint8", isConstant: true, value: 1n },
        { name: "TableB", type: "uint8", isConstant: true, value: 2n },
        { name: "us_type", type: "uint8", isArray: true },
        { name: "us", type: "UnionArray.U", isComplex: true, isArray: true },
      ]);
      expect(datatypes.get("UnionArray.StructWithArray")?.definitions).toEqual([
        { name: "arr", type: "float32", isArray: true, arrayLength: 4 },
      ]);
      expect(datatypes.get("UnionArray.U")?.definitions).toEqual([
        { name: "a_only", type: "string" },
        { name: "conflict", type: "int32" },
        { name: "shared", type: "int32" },
        { name: "b_only", type: "bool" },
      ]);
      expect(datatypes.has("UnionArray.TableA")).toBe(true);
      expect(datatypes.has("UnionArray.TableB")).toBe(true);
    });

    it("deserializes active union members and a mixed union vector", () => {
      const { deserialize } = parseFlatbufferSchema("UnionArray.Root", unionArraySchema);
      const message = buildUnionArrayMessage({
        u: { type: UnionType.TableA, shared: 10, conflict: 11, aOnly: "direct-a" },
        us: [
          { type: UnionType.TableA, shared: 20, conflict: 21, aOnly: "vector-a" },
          { type: UnionType.TableB, shared: 30, conflict: "vector-b", bOnly: true },
          undefined,
        ],
        arr: [1.25, 2.5, 3.75, 5],
        plain: 101,
      });

      expect(deserialize(message)).toEqual({
        u_type: UnionType.TableA,
        u: { shared: 10, conflict: 11, a_only: "direct-a" },
        us_type: [UnionType.TableA, UnionType.TableB, UnionType.NONE],
        us: [
          { shared: 20, conflict: 21, a_only: "vector-a" },
          { shared: 30, conflict: "vector-b", b_only: true },
          undefined,
        ],
        s: { arr: [1.25, 2.5, 3.75, 5] },
        plain: 101,
      });
    });

    it("advances past a NONE slot between active union vector members", () => {
      const { deserialize } = parseFlatbufferSchema("UnionArray.Root", unionArraySchema);
      const message = buildUnionArrayMessage({
        u: { type: UnionType.TableA, shared: 1, conflict: 2, aOnly: "direct" },
        us: [
          { type: UnionType.TableA, shared: 10, conflict: 11, aOnly: "first-a" },
          undefined,
          { type: UnionType.TableB, shared: 20, conflict: "last-b", bOnly: true },
        ],
        arr: [1, 2, 3, 4],
        plain: 5,
      });

      expect(deserialize(message)).toMatchObject({
        us_type: [UnionType.TableA, UnionType.NONE, UnionType.TableB],
        us: [
          { shared: 10, conflict: 11, a_only: "first-a" },
          undefined,
          { shared: 20, conflict: "last-b", b_only: true },
        ],
      });
    });

    it("advances past a leading NONE slot in a union vector", () => {
      const { deserialize } = parseFlatbufferSchema("UnionArray.Root", unionArraySchema);
      const message = buildUnionArrayMessage({
        u: { type: UnionType.TableB, shared: 1, conflict: "direct", bOnly: false },
        us: [
          undefined,
          { type: UnionType.TableA, shared: 30, conflict: 31, aOnly: "middle-a" },
          { type: UnionType.TableB, shared: 40, conflict: "last-b", bOnly: true },
        ],
        arr: [4, 3, 2, 1],
        plain: 6,
      });

      expect(deserialize(message)).toMatchObject({
        us_type: [UnionType.NONE, UnionType.TableA, UnionType.TableB],
        us: [
          undefined,
          { shared: 30, conflict: 31, a_only: "middle-a" },
          { shared: 40, conflict: "last-b", b_only: true },
        ],
      });
    });

    it("deserializes the other union member and preserves a NONE vector slot", () => {
      const { deserialize } = parseFlatbufferSchema("UnionArray.Root", unionArraySchema);
      const message = buildUnionArrayMessage({
        u: {
          type: UnionType.TableB,
          shared: -10,
          conflict: "direct-b",
          bOnly: true,
        },
        us: [undefined],
        arr: [-1, 0, 1, 2],
        plain: -7,
      });

      expect(deserialize(message)).toEqual({
        u_type: UnionType.TableB,
        u: { shared: -10, conflict: "direct-b", b_only: true },
        us_type: [UnionType.NONE],
        us: [undefined],
        s: { arr: [-1, 0, 1, 2] },
        plain: -7,
      });
    });

    it("omits the scalar union value when its discriminator is NONE", () => {
      const { deserialize } = parseFlatbufferSchema("UnionArray.Root", unionArraySchema);
      const message = buildUnionArrayMessage({
        us: [undefined],
        arr: [0, 0, 0, 0],
        plain: 0,
      });

      expect(deserialize(message)).toEqual({
        u_type: UnionType.NONE,
        us_type: [UnionType.NONE],
        us: [undefined],
        s: { arr: [0, 0, 0, 0] },
        plain: 0,
      });
    });
  });

  it("registers an empty synthesized union datatype", () => {
    const fakeSchema = {
      objects: [{ name: "TestMsg", fields: [], isStruct: false }],
      enums: [
        {
          name: "EmptyUnion",
          values: [{ name: "NONE", value: 0n, unionType: undefined }],
          isUnion: true,
        },
      ],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);
    jest.spyOn(Parser.prototype, "toObjectLambda").mockReturnValue(jest.fn());

    const { datatypes } = parseFlatbufferSchema("TestMsg", new Uint8Array());

    expect(datatypes.get("EmptyUnion")).toEqual({ definitions: [] });
  });

  it("rejects a struct union member because union members must be tables", () => {
    const fakeSchema = {
      objects: [
        { name: "TestMsg", fields: [], isStruct: false },
        { name: "StructMember", fields: [], isStruct: true },
      ],
      enums: [
        {
          name: "InvalidUnion",
          isUnion: true,
          values: [
            { name: "NONE", value: 0n, unionType: undefined },
            {
              name: "StructMember",
              value: 1n,
              unionType: { baseType: BaseType.Obj, index: 1 },
            },
          ],
        },
      ],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    expect(() => parseFlatbufferSchema("TestMsg", new Uint8Array())).toThrow(
      'Invalid schema, union "InvalidUnion" member "StructMember" is not a table.',
    );
  });

  it("rejects a union enum name that conflicts with an object datatype", () => {
    const fakeSchema = {
      objects: [
        { name: "TestMsg", fields: [], isStruct: false },
        { name: "Conflicting", fields: [], isStruct: false },
      ],
      enums: [{ name: "Conflicting", values: [], isUnion: true }],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    expect(() => parseFlatbufferSchema("TestMsg", new Uint8Array())).toThrow(
      'Invalid schema, union enum "Conflicting" conflicts with an object of the same name.',
    );
  });

  it("rejects fixed-length arrays with zero length", () => {
    const fakeSchema = {
      objects: [
        {
          name: "TestStruct",
          isStruct: true,
          fields: [
            {
              name: "arr",
              type: {
                baseType: BaseType.Array,
                element: BaseType.Float,
                fixedLength: 0,
                index: -1,
              },
            },
          ],
        },
      ],
      enums: [],
      rootTable: { name: "TestStruct" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    expect(() => parseFlatbufferSchema("TestStruct", new Uint8Array())).toThrow(
      'Invalid schema, fixed-length array field "arr" must have a positive length.',
    );
  });

  it.each([BaseType.Union, BaseType.Array])(
    "rejects fixed-length arrays containing %s",
    (element) => {
      const fakeSchema = {
        objects: [
          {
            name: "TestStruct",
            isStruct: true,
            fields: [
              {
                name: "arr",
                type: { baseType: BaseType.Array, element, fixedLength: 2, index: -1 },
              },
            ],
          },
        ],
        enums: [],
        rootTable: { name: "TestStruct" },
      };
      jest
        .spyOn(Schema, "getRootAsSchema")
        .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
          typeof Schema.getRootAsSchema
        >);

      expect(() => parseFlatbufferSchema("TestStruct", new Uint8Array())).toThrow(
        `Fixed-length arrays of ${BaseType[element]} are unsupported for field "arr".`,
      );
    },
  );

  it("maps fixed-length arrays of structs as complex arrays", () => {
    const fakeSchema = {
      objects: [
        {
          name: "OuterStruct",
          isStruct: true,
          fields: [
            {
              name: "children",
              type: {
                baseType: BaseType.Array,
                element: BaseType.Obj,
                fixedLength: 3,
                index: 1,
              },
            },
          ],
        },
        {
          name: "ChildStruct",
          isStruct: true,
          fields: [
            {
              name: "value",
              type: { baseType: BaseType.Int, element: BaseType.None, index: -1 },
            },
          ],
        },
      ],
      enums: [],
      rootTable: { name: "OuterStruct" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);
    jest.spyOn(Parser.prototype, "toObjectLambda").mockReturnValue(jest.fn());

    const { datatypes } = parseFlatbufferSchema("OuterStruct", new Uint8Array());

    expect(datatypes.get("OuterStruct")?.definitions).toEqual([
      {
        name: "children",
        type: "ChildStruct",
        isComplex: true,
        isArray: true,
        arrayLength: 3,
      },
    ]);
  });

  it("reports a missing field type as an invalid field type", () => {
    const fakeSchema = {
      objects: [
        {
          name: "TestMsg",
          isStruct: false,
          fields: [{ name: "broken", type: undefined }],
        },
      ],
      enums: [],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    expect(() => parseFlatbufferSchema("TestMsg", new Uint8Array())).toThrow(
      'Invalid schema, field "broken" has an invalid field type.',
    );
  });

  it.each([
    [BaseType.Union, BaseType.None, "u", "Union"],
    [BaseType.UType, BaseType.None, "u_type", "UType"],
    [BaseType.Vector, BaseType.Union, "us", "Vector<Union>"],
    [BaseType.Vector, BaseType.UType, "us_type", "Vector<UType>"],
  ])("rejects %s fields inside structs", (baseType, element, fieldName, typeName) => {
    const fakeSchema = {
      objects: [
        {
          name: "MaliciousStruct",
          isStruct: true,
          fields: [
            {
              name: fieldName,
              type: { baseType, element, index: 0 },
            },
          ],
        },
      ],
      enums: [],
      rootTable: { name: "MaliciousStruct" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    expect(() => parseFlatbufferSchema("MaliciousStruct", new Uint8Array())).toThrow(
      `Invalid schema, struct "MaliciousStruct" cannot contain ${typeName} field "${fieldName}".`,
    );
  });

  it("rejects paired union vector fields inside a malicious struct schema", () => {
    const fakeSchema = {
      objects: [
        {
          name: "MaliciousStruct",
          isStruct: true,
          fields: [
            {
              name: "payload",
              type: { baseType: BaseType.Vector, element: BaseType.Union, index: 0 },
            },
            {
              name: "payload_type",
              type: { baseType: BaseType.Vector, element: BaseType.UType, index: 0 },
            },
          ],
        },
      ],
      enums: [],
      rootTable: { name: "MaliciousStruct" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    expect(() => parseFlatbufferSchema("MaliciousStruct", new Uint8Array())).toThrow(
      'Invalid schema, struct "MaliciousStruct" cannot contain Vector<Union> field "payload".',
    );
  });

  it("throws when simple enum field has undefined values", () => {
    // Given
    const fakeSchema = {
      objects: [
        {
          name: "TestMsg",
          fields: [
            {
              name: "status",
              type: { baseType: BaseType.Int, index: 0, element: BaseType.None },
            },
          ],
        },
      ],
      enums: [{ name: "StatusEnum", values: undefined }],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    // When / Then
    expect(() => parseFlatbufferSchema("TestMsg", new Uint8Array())).toThrow(
      "Invalid schema, missing enum values for field type StatusEnum",
    );
  });

  it("throws 'Invalid schema' when vector enum field has undefined values", () => {
    // Given
    const fakeSchema = {
      objects: [
        {
          name: "TestMsg",
          fields: [
            {
              name: "items",
              type: { baseType: BaseType.Vector, element: BaseType.Int, index: 0 },
            },
          ],
        },
      ],
      enums: [{ name: "ItemEnum", values: undefined }],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    // When / Then
    expect(() => parseFlatbufferSchema("TestMsg", new Uint8Array())).toThrow("Invalid schema");
  });

  it("pushes enum constants before array field for a vector enum field", () => {
    // Given
    const fakeSchema = {
      objects: [
        {
          name: "TestMsg",
          fields: [
            {
              name: "statuses",
              type: { baseType: BaseType.Vector, element: BaseType.Int, index: 0 },
            },
          ],
        },
      ],
      enums: [
        {
          name: "Status",
          values: [
            { name: "ACTIVE", value: 0n },
            { name: "INACTIVE", value: 1n },
          ],
        },
      ],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);
    jest.spyOn(Parser.prototype, "toObjectLambda").mockReturnValue(jest.fn());

    // When
    const { datatypes } = parseFlatbufferSchema("TestMsg", new Uint8Array());

    // Then
    expect(datatypes.get("TestMsg")?.definitions).toEqual([
      { name: "ACTIVE", type: "int32", isConstant: true, value: 0n },
      { name: "INACTIVE", type: "int32", isConstant: true, value: 1n },
      { name: "statuses", type: "int32", isArray: true },
    ]);
  });

  it("skips objects with undefined fields without adding them to datatypes", () => {
    // Given
    const fakeSchema = {
      objects: [
        { name: "EmptyObj", fields: undefined },
        {
          name: "TestMsg",
          fields: [
            {
              name: "value",
              type: { baseType: BaseType.Int, index: -1, element: BaseType.None },
            },
          ],
        },
      ],
      enums: [],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);
    jest.spyOn(Parser.prototype, "toObjectLambda").mockReturnValue(jest.fn());

    // When
    const { datatypes } = parseFlatbufferSchema("TestMsg", new Uint8Array());

    // Then
    expect(datatypes.has("EmptyObj")).toBe(false);
    expect(datatypes.has("TestMsg")).toBe(true);
  });

  it("throws 'Unhandled BaseType' for an unknown vector element type", () => {
    // Given
    const fakeSchema = {
      objects: [
        {
          name: "TestMsg",
          fields: [
            {
              name: "data",
              type: { baseType: BaseType.Vector, element: 99 as BaseType, index: -1 },
            },
          ],
        },
      ],
      enums: [],
      rootTable: { name: "TestMsg" },
    };
    jest
      .spyOn(Schema, "getRootAsSchema")
      .mockReturnValue({ unpack: () => fakeSchema } as unknown as ReturnType<
        typeof Schema.getRootAsSchema
      >);

    // When / Then
    expect(() => parseFlatbufferSchema("TestMsg", new Uint8Array())).toThrow(
      "Unhandled BaseType: 99",
    );
  });
});
