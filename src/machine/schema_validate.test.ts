import { describe, it, expect } from "bun:test"
import { validate } from "./schema_validate"

describe("validate", () => {
  // Empty schema always passes
  it("returns null when schema has no constraints (empty schema always passes)", () => {
    expect(validate("anything", {})).toBeNull()
    expect(validate(42, {})).toBeNull()
    expect(validate(null, {})).toBeNull()
    expect(validate({}, {})).toBeNull()
  })

  // --- type: 'string' ---
  it("type check: 'string' passes for string value", () => {
    expect(validate("hello", { type: "string" })).toBeNull()
    expect(validate("", { type: "string" })).toBeNull()
  })

  it("type check: 'string' fails for non-string value", () => {
    const result = validate(123, { type: "string" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected string")
  })

  // --- type: 'boolean' ---
  it("type check: 'boolean' passes for boolean value", () => {
    expect(validate(true, { type: "boolean" })).toBeNull()
    expect(validate(false, { type: "boolean" })).toBeNull()
  })

  it("type check: 'boolean' fails for non-boolean value", () => {
    const result = validate("true", { type: "boolean" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected boolean")
  })

  // --- type: 'number' ---
  it("type check: 'number' passes for float value", () => {
    expect(validate(3.14, { type: "number" })).toBeNull()
    expect(validate(0, { type: "number" })).toBeNull()
  })

  it("type check: 'number' fails for non-number value", () => {
    const result = validate("3.14", { type: "number" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected number")
  })

  // --- type: 'integer' ---
  it("type check: 'integer' passes for integer value", () => {
    expect(validate(42, { type: "integer" })).toBeNull()
    expect(validate(0, { type: "integer" })).toBeNull()
    expect(validate(-5, { type: "integer" })).toBeNull()
  })

  it("type check: 'integer' fails for float (e.g. 1.5)", () => {
    const result = validate(1.5, { type: "integer" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected integer")
  })

  // --- type: 'array' ---
  it("type check: 'array' passes for array value", () => {
    expect(validate([], { type: "array" })).toBeNull()
    expect(validate([1, 2, 3], { type: "array" })).toBeNull()
  })

  it("type check: 'array' fails for object value", () => {
    const result = validate({ a: 1 }, { type: "array" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected array")
  })

  // --- type: 'object' ---
  it("type check: 'object' passes for plain object", () => {
    expect(validate({}, { type: "object" })).toBeNull()
    expect(validate({ a: 1 }, { type: "object" })).toBeNull()
  })

  it("type check: 'object' fails for array (array is not object)", () => {
    const result = validate([1, 2], { type: "object" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected object")
  })

  it("type check: 'object' fails for null", () => {
    const result = validate(null, { type: "object" })
    expect(result).not.toBeNull()
    expect(result).toContain("expected object")
  })

  // --- unknown type ---
  it("type check: unknown type string always passes (default branch)", () => {
    expect(validate("anything", { type: "unknownType" })).toBeNull()
    expect(validate(42, { type: "unknownType" })).toBeNull()
  })

  // --- type as array ---
  it("type as array: passes when value matches any listed type", () => {
    expect(validate("hello", { type: ["string", "number"] })).toBeNull()
    expect(validate(42, { type: ["string", "number"] })).toBeNull()
  })

  it("type as array: fails when value matches none of the listed types", () => {
    const result = validate(true, { type: ["string", "number"] })
    expect(result).not.toBeNull()
    expect(result).toContain("expected string|number")
  })

  // --- enum ---
  it("enum: passes when value is in enum list", () => {
    expect(validate("a", { enum: ["a", "b", "c"] })).toBeNull()
    expect(validate(1, { enum: [1, 2, 3] })).toBeNull()
  })

  it("enum: fails when value is not in enum list, error includes value", () => {
    const result = validate("d", { enum: ["a", "b", "c"] })
    expect(result).not.toBeNull()
    expect(result).toContain('"d"')
    expect(result).toContain("must be one of")
  })

  // --- required ---
  it("required: passes when all required keys are present", () => {
    expect(validate({ name: "Alice", age: 30 }, { required: ["name", "age"] })).toBeNull()
  })

  it("required: fails with correct path and key name when a required field is missing", () => {
    const result = validate({ name: "Alice" }, { required: ["name", "age"] })
    expect(result).not.toBeNull()
    expect(result).toContain('"age"')
    expect(result).toContain("missing required field")
    expect(result).toContain("$")
  })

  it("required: skipped when value is not an object (no false positive)", () => {
    // required check only applies when value is an object, so non-objects skip it
    expect(validate("a string", { required: ["foo"] })).toBeNull()
    expect(validate(null, { required: ["foo"] })).toBeNull()
    expect(validate(42, { required: ["foo"] })).toBeNull()
  })

  // --- properties ---
  it("properties: passes when nested property satisfies its sub-schema", () => {
    expect(
      validate(
        { name: "Alice", age: 30 },
        { properties: { name: { type: "string" }, age: { type: "number" } } }
      )
    ).toBeNull()
  })

  it("properties: fails with dotted path (e.g. '$.foo') when nested property violates sub-schema", () => {
    const result = validate(
      { foo: 123 },
      { properties: { foo: { type: "string" } } }
    )
    expect(result).not.toBeNull()
    expect(result).toContain("$.foo")
    expect(result).toContain("expected string")
  })

  it("properties: skips keys that are absent from the value object (no false positive for optional keys)", () => {
    // 'bar' is defined in properties but absent from value — should not cause an error
    expect(
      validate(
        { foo: "hello" },
        { properties: { foo: { type: "string" }, bar: { type: "number" } } }
      )
    ).toBeNull()
  })

  // --- items ---
  it("items: passes when every array element satisfies sub-schema", () => {
    expect(validate([1, 2, 3], { items: { type: "number" } })).toBeNull()
    expect(validate([], { items: { type: "string" } })).toBeNull()
  })

  it("items: fails with indexed path (e.g. '$[1]') when an element violates sub-schema", () => {
    const result = validate(["ok", 42], { items: { type: "string" } })
    expect(result).not.toBeNull()
    expect(result).toContain("$[1]")
    expect(result).toContain("expected string")
  })

  it("items: skipped when value is not an array", () => {
    // items check only applies to arrays
    expect(validate("not an array", { items: { type: "number" } })).toBeNull()
    expect(validate({ a: 1 }, { items: { type: "number" } })).toBeNull()
  })

  // --- custom path argument ---
  it("custom path argument: error message uses supplied path prefix instead of '$'", () => {
    const result = validate(123, { type: "string" }, "$.myField")
    expect(result).not.toBeNull()
    expect(result).toContain("$.myField")
    expect(result).not.toContain("$:")
  })

  // --- combined schema ---
  it("combined schema: required + properties + type all validated together", () => {
    const schema = {
      type: "object" as const,
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
    }

    // valid value
    expect(validate({ name: "Bob", age: 25 }, schema)).toBeNull()

    // wrong type for age
    const wrongAge = validate({ name: "Bob", age: 25.5 }, schema)
    expect(wrongAge).not.toBeNull()
    expect(wrongAge).toContain("$.age")

    // missing required field
    const missingName = validate({ age: 25 }, schema)
    expect(missingName).not.toBeNull()
    expect(missingName).toContain('"name"')

    // not an object at top level
    const notObject = validate("oops", schema)
    expect(notObject).not.toBeNull()
    expect(notObject).toContain("expected object")
  })
})
