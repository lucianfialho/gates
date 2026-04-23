// Minimal JSON Schema subset validator.
// Supports: type, required, properties, items, enum.
// Returns null on pass, error string on failure.

type Schema = {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  enum?: unknown[]
}

const checkType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "string":  return typeof value === "string"
    case "boolean": return typeof value === "boolean"
    case "number":  return typeof value === "number"
    case "integer": return typeof value === "number" && Number.isInteger(value)
    case "array":   return Array.isArray(value)
    case "object":  return typeof value === "object" && value !== null && !Array.isArray(value)
    default: return true
  }
}

export const validate = (value: unknown, schema: Schema, path = "$"): string | null => {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => checkType(value, t))) {
      return `${path}: expected ${types.join("|")}, got ${Array.isArray(value) ? "array" : typeof value}`
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      return `${path}: must be one of [${schema.enum.join(", ")}], got ${JSON.stringify(value)}`
    }
  }

  if (schema.required && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required) {
      if (!(key in obj)) {
        return `${path}: missing required field "${key}"`
      }
    }
  }

  if (schema.properties && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
        const err = validate(obj[key], subSchema, `${path}.${key}`)
        if (err) return err
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(value[i], schema.items, `${path}[${i}]`)
      if (err) return err
    }
  }

  return null
}
