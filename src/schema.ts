// Minimal JSON-Schema subset validator (type, properties, required, enum,
// minimum, maximum, items, additionalProperties, oneOf-of-types via `type` array).
// Kept dependency-free so config errors are reported deterministically.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  description?: string;
};

export class SchemaError extends Error {
  constructor(public readonly label: string, public readonly problems: string[]) {
    super(`Invalid ${label}:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SchemaError';
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

export function validate(schema: JsonSchema, value: unknown, at = '$', problems: string[] = []): string[] {
  const actual = typeOf(value);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, actual))) {
      problems.push(`${at}: expected ${types.join('|')}, got ${actual}`);
      return problems;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${at}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at}: must not be empty`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${at}: must match ${schema.pattern}`);
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => validate(schema.items!, item, `${at}[${i}]`, problems));
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) problems.push(`${at}.${key}: is required`);
    }
    for (const [key, child] of Object.entries(obj)) {
      const prop = schema.properties?.[key];
      if (prop) validate(prop, child, `${at}.${key}`, problems);
      else if (schema.additionalProperties === false) problems.push(`${at}.${key}: unknown property`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, child, `${at}.${key}`, problems);
    }
  }
  return problems;
}

export function assertValid<T>(schema: JsonSchema, value: unknown, label: string): T {
  const problems = validate(schema, value);
  if (problems.length) throw new SchemaError(label, problems);
  return value as T;
}
