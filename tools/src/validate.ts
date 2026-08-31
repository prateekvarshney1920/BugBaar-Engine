import type { JsonSchema, JsonSchemaProperty } from "./types.js";

export class ToolValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "ToolValidationError";
  }
}

function matchesType(value: unknown, type: JsonSchemaProperty["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function checkProperty(path: string, value: unknown, schema: JsonSchemaProperty, issues: string[]): void {
  if (!matchesType(value, schema.type)) {
    issues.push(`${path}: expected ${schema.type}, received ${value === null ? "null" : typeof value}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    issues.push(`${path}: expected one of ${schema.enum.join(", ")}`);
  }
  if (schema.type === "array" && schema.items) {
    for (const [index, item] of (value as unknown[]).entries()) {
      checkProperty(`${path}[${index}]`, item, schema.items, issues);
    }
  }
}

/**
 * Validates and normalises tool arguments against the tool's JSON schema.
 *
 * This is deliberately a small hand-rolled subset rather than a full JSON
 * Schema implementation: tool parameters are authored in-repo, so the goal is
 * clear error messages for the model, not spec completeness.
 */
export function validateInput(schema: JsonSchema, input: unknown): Record<string, unknown> {
  const issues: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolValidationError("Tool input must be an object", ["input: expected object"]);
  }

  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of schema.required ?? []) {
    if (source[key] === undefined) {
      issues.push(`${key}: required`);
    }
  }

  for (const [key, property] of Object.entries(schema.properties)) {
    const value = source[key] ?? property.default;
    if (value === undefined) continue;
    checkProperty(key, value, property, issues);
    result[key] = value;
  }

  if (schema.additionalProperties !== false) {
    for (const [key, value] of Object.entries(source)) {
      if (!(key in schema.properties)) result[key] = value;
    }
  }

  if (issues.length > 0) {
    throw new ToolValidationError(`Invalid arguments: ${issues.join("; ")}`, issues);
  }

  return result;
}
