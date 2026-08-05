// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ByteBuffer } from "flatbuffers";
import { BaseType, Schema, SchemaT, FieldT, Parser, Table } from "flatbuffers_reflection";

import { MessageDefinitionField } from "@lichtblick/message-definition";

import { MessageDefinitionMap } from "./types";

function typeForSimpleField(type: BaseType): string {
  switch (type) {
    case BaseType.Bool:
      return "bool";
    case BaseType.Byte:
      return "int8";
    case BaseType.UType:
    case BaseType.UByte:
      return "uint8";
    case BaseType.Short:
      return "int16";
    case BaseType.UShort:
      return "uint16";
    case BaseType.Int:
      return "int32";
    case BaseType.UInt:
      return "uint32";
    case BaseType.Long:
      return "int64";
    case BaseType.ULong:
      return "uint64";
    case BaseType.Float:
      return "float32";
    case BaseType.Double:
      return "float64";
    case BaseType.String:
      return "string";
    case BaseType.Vector:
    case BaseType.Obj:
    case BaseType.Union:
    case BaseType.Array:
      throw new Error(`${type} is not a simple type.`);
    case BaseType.None:
    case BaseType.MaxBaseType:
      throw new Error("None is not a valid type.");
    default:
      throw new Error(`Unhandled BaseType: ${type}`);
  }
}

function flatbufferString(unchecked: string | Uint8Array | null | undefined): string {
  if (typeof unchecked === "string") {
    return unchecked;
  }
  throw new Error(`Expected string, found ${typeof unchecked}`);
}

function baseTypeName(type: BaseType): string {
  const baseTypeNames = BaseType as unknown as Record<number, string | undefined>;
  return baseTypeNames[type] ?? `unknown (${type})`;
}

function unionEnum(schema: SchemaT, enumIndex: number, fieldName: string) {
  const enumDefinition = schema.enums[enumIndex];
  if (enumDefinition?.isUnion !== true) {
    throw new Error(`Invalid schema, missing union enum for field "${fieldName}".`);
  }
  return enumDefinition;
}

function typeForUnionField(
  schema: SchemaT,
  field: FieldT,
  shape: "scalar" | "array",
): MessageDefinitionField[] {
  const fieldName = flatbufferString(field.name);
  const fieldType = field.type;
  if (fieldType == undefined) {
    throw new Error(`Invalid schema, field "${fieldName}" has an invalid field type.`);
  }
  const enumDefinition = unionEnum(schema, fieldType.index, fieldName);
  const isArray = shape === "array";
  const definitions: MessageDefinitionField[] = enumDefinition.values.map((enumValue) => ({
    name: flatbufferString(enumValue.name),
    type: "uint8",
    isConstant: true,
    value: enumValue.value,
  }));

  definitions.push({
    name: `${fieldName}_type`,
    type: "uint8",
    ...(isArray && { isArray: true }),
  });
  definitions.push({
    name: fieldName,
    type: flatbufferString(enumDefinition.name),
    isComplex: true,
    ...(isArray && { isArray: true }),
  });
  return definitions;
}

function typeForField(schema: SchemaT, field: FieldT): MessageDefinitionField[] {
  const fieldName = flatbufferString(field.name);
  if (field.type == undefined) {
    throw new Error(`Invalid schema, field "${fieldName}" has an invalid field type.`);
  }

  const fields: MessageDefinitionField[] = [];
  switch (field.type.baseType) {
    case BaseType.UType:
    case BaseType.Bool:
    case BaseType.Byte:
    case BaseType.UByte:
    case BaseType.Short:
    case BaseType.UShort:
    case BaseType.Int:
    case BaseType.UInt:
    case BaseType.Long:
    case BaseType.ULong:
    case BaseType.Float:
    case BaseType.Double:
    case BaseType.String:
    case BaseType.None: {
      const simpleType = typeForSimpleField(field.type.baseType);
      // Enums have magic logic--the constants definitions for the enum values
      // have to go right before the enum itself.
      if (field.type.index !== -1) {
        const enums = schema.enums[field.type.index]?.values;
        if (enums == undefined) {
          throw new Error(
            `Invalid schema, missing enum values for field type ${
              schema.enums[field.type.index]?.name
            }`,
          );
        }
        for (const enumVal of enums) {
          fields.push({
            name: flatbufferString(enumVal.name),
            type: simpleType,
            isConstant: true,
            value: enumVal.value,
          });
        }
      }
      fields.push({ name: fieldName, type: simpleType });
      break;
    }
    case BaseType.Vector:
      switch (field.type.element) {
        case BaseType.Vector:
        case BaseType.Array:
        case BaseType.None:
          throw new Error(
            `Vectors of ${baseTypeName(field.type.element)} are unsupported for field "${fieldName}".`,
          );
        case BaseType.Union:
          fields.push(...typeForUnionField(schema, field, "array"));
          break;
        case BaseType.Obj:
          fields.push({
            name: fieldName,
            type: flatbufferString(schema.objects[field.type.index]?.name),
            isComplex: true,
            isArray: true,
          });
          break;
        default: {
          const type = typeForSimpleField(field.type.element);
          // Enums have magic logic--the constants definitions for the enum
          // values have to go right before the enum itself.
          if (field.type.index !== -1) {
            const enums = schema.enums[field.type.index]?.values;
            if (enums == undefined) {
              throw new Error("Invalid schema");
            }
            for (const enumVal of enums) {
              fields.push({
                name: flatbufferString(enumVal.name),
                type,
                isConstant: true,
                value: enumVal.value,
              });
            }
          }
          fields.push({ name: fieldName, type, isArray: true });
          break;
        }
      }
      break;
    case BaseType.Obj:
      fields.push({
        name: fieldName,
        type: flatbufferString(schema.objects[field.type.index]?.name),
        isComplex: true,
      });
      break;
    case BaseType.Union:
      fields.push(...typeForUnionField(schema, field, "scalar"));
      break;
    case BaseType.Array: {
      if (!Number.isInteger(field.type.fixedLength) || field.type.fixedLength <= 0) {
        throw new Error(
          `Invalid schema, fixed-length array field "${fieldName}" must have a positive length.`,
        );
      }
      switch (field.type.element) {
        case BaseType.UType:
        case BaseType.Bool:
        case BaseType.Byte:
        case BaseType.UByte:
        case BaseType.Short:
        case BaseType.UShort:
        case BaseType.Int:
        case BaseType.UInt:
        case BaseType.Long:
        case BaseType.ULong:
        case BaseType.Float:
        case BaseType.Double:
          fields.push({
            name: fieldName,
            type: typeForSimpleField(field.type.element),
            isArray: true,
            arrayLength: field.type.fixedLength,
          });
          break;
        case BaseType.Obj: {
          const elementObject = schema.objects[field.type.index];
          if (elementObject == undefined) {
            throw new Error(
              `Invalid schema, missing object for fixed-length array field "${fieldName}".`,
            );
          }
          const elementName = flatbufferString(elementObject.name);
          if (!elementObject.isStruct) {
            throw new Error(
              `Invalid schema, fixed-length array field "${fieldName}" references non-struct object "${elementName}".`,
            );
          }
          fields.push({
            name: fieldName,
            type: elementName,
            isComplex: true,
            isArray: true,
            arrayLength: field.type.fixedLength,
          });
          break;
        }
        case BaseType.Union:
        case BaseType.Array:
          throw new Error(
            `Fixed-length arrays of ${baseTypeName(field.type.element)} are unsupported for field "${fieldName}".`,
          );
        default:
          throw new Error(
            `Invalid fixed-length array element type ${baseTypeName(
              field.type.element,
            )} for field "${fieldName}".`,
          );
      }
      break;
    }
    case BaseType.MaxBaseType:
      throw new Error(`Unsupported field type ${baseTypeName(field.type.baseType)}.`);
  }
  return fields;
}

function unionDiscriminatorFieldNames(objectFields: FieldT[]): Set<string> {
  const names = new Set<string>();
  for (const field of objectFields) {
    if (
      field.type?.baseType === BaseType.Union ||
      (field.type?.baseType === BaseType.Vector && field.type.element === BaseType.Union)
    ) {
      names.add(`${flatbufferString(field.name)}_type`);
    }
  }
  return names;
}

function validateStructUnionFields(objectName: string, objectFields: FieldT[]): void {
  for (const field of objectFields) {
    const baseType = field.type?.baseType;
    const elementType = field.type?.element;
    let unsupportedType: string | undefined;
    if (baseType === BaseType.Union || baseType === BaseType.UType) {
      unsupportedType = baseTypeName(baseType);
    } else if (
      baseType === BaseType.Vector &&
      (elementType === BaseType.Union || elementType === BaseType.UType)
    ) {
      unsupportedType = `Vector<${baseTypeName(elementType)}>`;
    }

    if (unsupportedType != undefined) {
      throw new Error(
        `Invalid schema, struct "${objectName}" cannot contain ${unsupportedType} field "${flatbufferString(
          field.name,
        )}".`,
      );
    }
  }
}

function validateUnionDiscriminators(objectName: string, objectFields: FieldT[]): void {
  for (const field of objectFields) {
    const isUnion = field.type?.baseType === BaseType.Union;
    const isUnionVector =
      field.type?.baseType === BaseType.Vector && field.type.element === BaseType.Union;
    if (!isUnion && !isUnionVector) {
      continue;
    }

    const fieldName = flatbufferString(field.name);
    const discriminatorName = `${fieldName}_type`;
    const discriminator = objectFields.find(
      (candidate) => flatbufferString(candidate.name) === discriminatorName,
    );
    const validType = isUnionVector
      ? discriminator?.type?.baseType === BaseType.Vector &&
        discriminator.type.element === BaseType.UType
      : discriminator?.type?.baseType === BaseType.UType;
    if (!validType || discriminator?.type?.index !== field.type?.index) {
      throw new Error(
        `Invalid schema, union field "${objectName}.${fieldName}" has an invalid or missing discriminator field "${discriminatorName}".`,
      );
    }
  }
}

function addUnionDatatypes(schema: SchemaT, datatypes: MessageDefinitionMap): void {
  for (const enumDefinition of schema.enums) {
    if (!enumDefinition.isUnion) {
      continue;
    }
    const unionName = flatbufferString(enumDefinition.name);
    if (datatypes.has(unionName)) {
      throw new Error(
        `Invalid schema, union enum "${unionName}" conflicts with an object of the same name.`,
      );
    }
    const definitions: MessageDefinitionField[] = [];
    const definitionsByName = new Map<string, MessageDefinitionField>();
    for (const enumValue of enumDefinition.values) {
      if (enumValue.value <= 0n) {
        continue;
      }
      const unionType = enumValue.unionType;
      if (unionType?.baseType !== BaseType.Obj) {
        throw new Error(
          `Invalid schema, union "${unionName}" member "${flatbufferString(
            enumValue.name,
          )}" is not a table.`,
        );
      }
      const memberObject = schema.objects[unionType.index];
      if (memberObject == undefined) {
        throw new Error(
          `Invalid schema, missing table for union "${unionName}" member "${flatbufferString(
            enumValue.name,
          )}".`,
        );
      }
      const memberName = flatbufferString(memberObject.name);
      if (memberObject.isStruct) {
        throw new Error(
          `Invalid schema, union "${unionName}" member "${memberName}" is not a table.`,
        );
      }
      const memberDefinitions = datatypes.get(memberName)?.definitions;
      if (memberDefinitions == undefined) {
        throw new Error(
          `Invalid schema, missing table datatype "${memberName}" for union "${unionName}".`,
        );
      }
      for (const definition of memberDefinitions) {
        const existing = definitionsByName.get(definition.name);
        if (existing != undefined) {
          // Identical names and types are deduplicated. If the types differ, retain the first
          // declaration: a union value can only hold one member at runtime, and first-wins keeps
          // the synthesized path superset deterministic.
          continue;
        }
        definitionsByName.set(definition.name, definition);
        definitions.push(definition);
      }
    }
    datatypes.set(unionName, { definitions });
  }
}

/**
 * Parse a flatbuffer binary schema and produce datatypes and a deserializer function.
 */
export function parseFlatbufferSchema(
  schemaName: string,
  schemaArray: Uint8Array,
): {
  datatypes: MessageDefinitionMap;
  deserialize: (buffer: ArrayBufferView) => unknown;
} {
  const datatypes: MessageDefinitionMap = new Map();
  const schemaBuffer = new ByteBuffer(schemaArray);
  const rawSchema = Schema.getRootAsSchema(schemaBuffer);
  const schema = rawSchema.unpack();

  let typeIndex = -1;
  for (let schemaIndex = 0; schemaIndex < schema.objects.length; ++schemaIndex) {
    const object = schema.objects[schemaIndex];
    if (object?.name === schemaName) {
      typeIndex = schemaIndex;
    }
    let fields: MessageDefinitionField[] = [];
    if (object?.fields == undefined) {
      continue;
    }
    const objectName = flatbufferString(object.name);
    if (object.isStruct) {
      validateStructUnionFields(objectName, object.fields);
    }
    validateUnionDiscriminators(objectName, object.fields);
    const discriminatorNames = unionDiscriminatorFieldNames(object.fields);
    for (const field of object.fields) {
      if (discriminatorNames.has(flatbufferString(field.name))) {
        continue;
      }
      if (field.type?.baseType === BaseType.Array && !object.isStruct) {
        throw new Error(
          `Invalid schema, fixed-length array field "${objectName}.${flatbufferString(
            field.name,
          )}" is not inside a struct.`,
        );
      }
      fields = fields.concat(typeForField(schema, field));
    }
    datatypes.set(objectName, { definitions: fields });
  }
  addUnionDatatypes(schema, datatypes);
  if (typeIndex === -1) {
    if (schema.rootTable?.name !== schemaName) {
      throw new Error(
        `Type "${schemaName}" is not available in the schema for "${schema.rootTable?.name}".`,
      );
    }
  }
  const parser = new Parser(rawSchema);
  // We set readDefaults=true to ensure that the reader receives default values for unset fields, or
  // fields that were explicitly set but with ForceDefaults(false) on the writer side. This is
  // necessary because `datatypes` does not include information about default values from the
  // schema. See discussion: <https://github.com/foxglove/studio/pull/6256>
  const toObject = parser.toObjectLambda(typeIndex, /*readDefaults=*/ true);
  const deserialize = (buffer: ArrayBufferView) => {
    const byteBuffer = new ByteBuffer(
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    );
    const table = new Table(
      byteBuffer,
      typeIndex,
      byteBuffer.readInt32(byteBuffer.position()) + byteBuffer.position(),
      false,
    );
    return toObject(table);
  };
  return { datatypes, deserialize };
}
