import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { type ToolCall } from "./Gate.js"
import { selectiveContextGate, extractFilePaths } from "./ContextScope.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCall = (name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id: "test-id",
  name,
  input,
})

async function runGateAsync(eff: ReturnType<typeof selectiveContextGate.check>) {
  try {
    const { Effect } = await import("effect")
    await Effect.runPromise(eff)
    return { ok: true as const }
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = e as any
    if (err?.gate === "SelectiveContextGate") return { ok: false as const, error: err }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(process.cwd(), ".tmp-scope-test")

beforeEach(() => {
  fs.mkdirSync(path.join(FIXTURE_DIR, ".gates"), { recursive: true })
  // Write gates.config.json with context_scope = analyze_only
  fs.writeFileSync(
    path.join(FIXTURE_DIR, "gates.config.json"),
    JSON.stringify({ context_scope: "analyze_only" })
  )
  // Write context.yaml with phase = implement
  fs.writeFileSync(
    path.join(FIXTURE_DIR, ".gates", "context.yaml"),
    "phase: implement\n"
  )
  // Write relevant.json — only src/context/RelevantPaths.ts is in scope
  fs.writeFileSync(
    path.join(FIXTURE_DIR, ".gates", "relevant.json"),
    JSON.stringify(["src/context/RelevantPaths.ts"])
  )
})

afterEach(() => {
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// selectiveContextGate.matches
// ---------------------------------------------------------------------------

describe("selectiveContextGate.matches", () => {
  it("returns true for file-related tools", () => {
    expect(selectiveContextGate.matches(makeCall("read"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("read_lines"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("edit"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("write"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("write_lines"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("glob"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("grep"))).toBe(true)
    expect(selectiveContextGate.matches(makeCall("bash"))).toBe(true)
  })

  it("returns false for non-file tools", () => {
    expect(selectiveContextGate.matches(makeCall("gh_issue_list"))).toBe(false)
    expect(selectiveContextGate.matches(makeCall("gh_issue_create"))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// selectiveContextGate.check — bypass conditions
// ---------------------------------------------------------------------------

describe("selectiveContextGate.check bypass", () => {
  it("passes when context_scope is absent (full tree mode)", async () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-no-scope-"))
    const orig = process.cwd()
    try {
      fs.writeFileSync(path.join(tmp, "gates.config.json"), JSON.stringify({}))
      fs.mkdirSync(path.join(tmp, ".gates"), { recursive: true })
      fs.writeFileSync(path.join(tmp, ".gates", "context.yaml"), "phase: implement\n")
      fs.writeFileSync(
        path.join(tmp, ".gates", "relevant.json"),
        JSON.stringify(["src/context/RelevantPaths.ts"])
      )
      process.chdir(tmp)
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("read", { path: "src/agent/Loop.ts" }))
      )
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(orig)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("passes (no-op) during analyze phase", async () => {
    const orig = process.cwd()
    process.chdir(FIXTURE_DIR)
    try {
      // Ensure phase is "analyze"
      fs.writeFileSync(
        path.join(FIXTURE_DIR, ".gates", "context.yaml"),
        "phase: analyze\n"
      )
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("read", { path: "src/agent/Loop.ts" }))
      )
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(orig)
    }
  })

  it("passes when relevant.json is absent (no restriction yet)", async () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-no-relevant-"))
    const orig = process.cwd()
    try {
      fs.writeFileSync(
        tmp + "/gates.config.json",
        JSON.stringify({ context_scope: "analyze_only" })
      )
      fs.mkdirSync(path.join(tmp, ".gates"), { recursive: true })
      fs.writeFileSync(path.join(tmp, ".gates", "context.yaml"), "phase: implement\n")
      // No relevant.json file
      process.chdir(tmp)
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("read", { path: "src/agent/Loop.ts" }))
      )
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(orig)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// selectiveContextGate.check — enforcement
// ---------------------------------------------------------------------------

describe("selectiveContextGate.check enforcement", () => {
  it("blocks a file not in relevantPaths during implement phase", async () => {
    const orig = process.cwd()
    process.chdir(FIXTURE_DIR)
    try {
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("read", { path: "src/agent/Loop.ts" }))
      )
      expect(r.ok).toBe(false)
      expect(r.error?.gate).toBe("SelectiveContextGate")
      expect(r.error?.reason).toContain("Loop.ts")
    } finally {
      process.chdir(orig)
    }
  })

  it("passes a file that IS in relevantPaths", async () => {
    const orig = process.cwd()
    process.chdir(FIXTURE_DIR)
    try {
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("read", { path: "src/context/RelevantPaths.ts" }))
      )
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(orig)
    }
  })

  it("passes a tool call with no file paths", async () => {
    const orig = process.cwd()
    process.chdir(FIXTURE_DIR)
    try {
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("bash", { command: "echo hello" }))
      )
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(orig)
    }
  })

  it("empty relevantPaths means no restriction (fallback to full tree)", async () => {
    const tmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-empty-"))
    const orig = process.cwd()
    try {
      fs.writeFileSync(
        tmp + "/gates.config.json",
        JSON.stringify({ context_scope: "analyze_only" })
      )
      fs.mkdirSync(path.join(tmp, ".gates"), { recursive: true })
      fs.writeFileSync(path.join(tmp, ".gates", "context.yaml"), "phase: implement\n")
      fs.writeFileSync(path.join(tmp, ".gates", "relevant.json"), JSON.stringify([]))
      process.chdir(tmp)
      const r = await runGateAsync(
        selectiveContextGate.check(makeCall("read", { path: "src/agent/Loop.ts" }))
      )
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(orig)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// extractFilePaths helper
// ---------------------------------------------------------------------------

describe("extractFilePaths", () => {
  it("extracts path from 'read' call", () => {
    const paths = extractFilePaths(makeCall("read", { path: "src/agent/Loop.ts" }))
    expect(paths).toEqual(["src/agent/Loop.ts"])
  })

  it("extracts path from 'edit' call", () => {
    const paths = extractFilePaths(
      makeCall("edit", { path: "src/config/GatesConfig.ts", old_string: "foo", new_string: "bar" })
    )
    expect(paths).toContain("src/config/GatesConfig.ts")
  })

  it("extracts multiple paths from bash command", () => {
    const paths = extractFilePaths(
      makeCall("bash", { command: "cp src/index.ts src/index.ts.bak && rm src/config/GatesConfig.ts" })
    )
    expect(paths).toContain("src/index.ts")
    expect(paths).toContain("src/config/GatesConfig.ts")
  })

  it("ignores non-path strings", () => {
    const paths = extractFilePaths(
      makeCall("bash", { command: "echo 'hello world' && npm run build" })
    )
    expect(paths).not.toContain("hello")
    expect(paths).not.toContain("world")
  })

  it("returns empty array for no paths", () => {
    const paths = extractFilePaths(makeCall("bash", { command: "echo hello" }))
    expect(paths).toEqual([])
  })
})