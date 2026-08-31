import type { ErrorBody } from "./contracts.js";

/**
 * Small runtime guards for request bodies.
 *
 * The backend validates every inbound payload before it reaches a service —
 * `express.json()` guarantees valid JSON, never a valid shape.
 */
export class RequestValidationError extends Error {
  readonly status = 400;
  readonly code = "invalid_request";

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function asObject(value: unknown, label = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  source: Record<string, unknown>,
  key: string,
  options: { maxLength?: number } = {},
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestValidationError(`"${key}" is required and must be a non-empty string`);
  }
  const maxLength = options.maxLength ?? 100_000;
  if (value.length > maxLength) {
    throw new RequestValidationError(`"${key}" exceeds the maximum length of ${maxLength} characters`);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string, maxLength = 10_000): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RequestValidationError(`"${key}" must be a string`);
  if (value.length > maxLength) throw new RequestValidationError(`"${key}" exceeds ${maxLength} characters`);
  return value;
}

export function optionalNumber(
  source: Record<string, unknown>,
  key: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`"${key}" must be a number`);
  }
  if (bounds.min !== undefined && value < bounds.min)
    throw new RequestValidationError(`"${key}" must be >= ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max)
    throw new RequestValidationError(`"${key}" must be <= ${bounds.max}`);
  return value;
}

export function requireArray(source: Record<string, unknown>, key: string, maxItems = 500): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new RequestValidationError(`"${key}" must be an array`);
  if (value.length === 0) throw new RequestValidationError(`"${key}" must not be empty`);
  if (value.length > maxItems) throw new RequestValidationError(`"${key}" must contain at most ${maxItems} items`);
  return value;
}

export function errorBody(code: string, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) }, requestId };
}
