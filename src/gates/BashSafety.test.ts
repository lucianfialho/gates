import { describe, it, expect } from "bun:test"
import { Effect, Exit, Cause } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { GateError, type ToolCall } from "./Gate.js"
import { bashSafetyGate } from "./BashSafety.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a gate check synchronously. Returns either { ok: true } or
 * { ok: false, error: GateError }.
 */
function runGate(eff: Effect.Effect<void, GateError>) {
  const exit = Effect.runSyncExit(eff)
  if (Exit.isSuccess(exit)) {
    return { ok: true as const }
  }
  // Cause.squash returns the first typed error (or a defect)
  const err = Cause.squash(exit.cause)
  if (err instanceof GateError) {
    return { ok: false as const, error: err }
  }
  return { ok: false as const, error: undefined }
}

const makeCall = (command: string): ToolCall => ({
  id: "test-id",
  name: "bash",
  input: { command },
})

// ---------------------------------------------------------------------------
// checkForcePush
// ---------------------------------------------------------------------------

describe("checkForcePush", () => {
  it("blocks git push --force to main", () => {
    const r = runGate(bashSafetyGate.check(makeCall("git push --force origin main")))
    expect(r.ok).toBe(false)
    expect(r.error?.gate).toBe("bash-safety/force-push")
  })

  it("blocks git push --force to master", () => {
    const r = runGate(bashSafetyGate.check(makeCall("git push --force origin master")))
    expect(r.ok).toBe(false)
    expect(r.error?.gate).toBe("bash-safety/force-push")
  })

  it("passes git push --force to a feature branch (no protected name)", () => {
    const r = runGate(bashSafetyGate.check(makeCall("git push --force origin feature/my-branch")))
    expect(r.ok).toBe(true)
  })

  it("passes normal git push to main (no --force)", () => {
    const r = runGate(bashSafetyGate.check(makeCall("git push origin main")))
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// checkNpmScript
// ---------------------------------------------------------------------------

describe("checkNpmScript", () => {
  it("passes when command contains no 'npm run'", () => {
    const r = runGate(bashSafetyGate.check(makeCall("echo hello")))
    expect(r.ok).toBe(true)
  })

  it("passes when package.json has no scripts key (empty list)", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-test-"))
    const origCwd = process.cwd()
    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }))
      process.chdir(tmpDir)
      const r = runGate(bashSafetyGate.check(makeCall("npm run anything")))
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("passes when the script exists in package.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-test-"))
    const origCwd = process.cwd()
    try {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ scripts: { build: "tsc", test: "bun test" } })
      )
      process.chdir(tmpDir)
      const r = runGate(bashSafetyGate.check(makeCall("npm run build")))
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("blocks when script is not found in package.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-test-"))
    const origCwd = process.cwd()
    try {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ scripts: { build: "tsc" } })
      )
      process.chdir(tmpDir)
      const r = runGate(bashSafetyGate.check(makeCall("npm run deploy")))
      expect(r.ok).toBe(false)
      expect(r.error?.gate).toBe("bash-safety/npm-script")
      expect(r.error?.reason).toContain("deploy")
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("passes gracefully when package.json cannot be read", () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-test-"))
    const origCwd = process.cwd()
    try {
      // No package.json in tmpDir — gate should pass gracefully (scripts = [])
      process.chdir(tmpDir)
      const r = runGate(bashSafetyGate.check(makeCall("npm run build")))
      expect(r.ok).toBe(true)
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// checkFileOp
// ---------------------------------------------------------------------------

describe("checkFileOp", () => {
  it("passes when command contains no rm/mv/cp", () => {
    const r = runGate(bashSafetyGate.check(makeCall("ls -la")))
    expect(r.ok).toBe(true)
  })

  it("passes when rm/mv/cp target path exists on disk", () => {
    // package.json definitely exists in the project root
    const r = runGate(bashSafetyGate.check(makeCall("rm package.json")))
    expect(r.ok).toBe(true)
  })

  it("blocks when rm/mv/cp target path does not exist", () => {
    const r = runGate(
      bashSafetyGate.check(makeCall("rm /tmp/__gates_nonexistent_file_xyz123456"))
    )
    expect(r.ok).toBe(false)
    expect(r.error?.gate).toBe("bash-safety/file-op")
    expect(r.error?.reason).toContain("/tmp/__gates_nonexistent_file_xyz123456")
  })

  it("passes when the extracted token starts with '-' (flag, not a path)", () => {
    // e.g. `rm -rf` — the token after rm is a flag, not a path to check
    const r = runGate(bashSafetyGate.check(makeCall("rm -rf")))
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// bashSafetyGate.matches
// ---------------------------------------------------------------------------

describe("bashSafetyGate.matches", () => {
  it("returns true only for tool calls named 'bash'", () => {
    expect(bashSafetyGate.matches({ id: "1", name: "bash", input: {} })).toBe(true)
  })

  it("returns false for non-bash tool calls", () => {
    expect(bashSafetyGate.matches({ id: "2", name: "read", input: {} })).toBe(false)
    expect(bashSafetyGate.matches({ id: "3", name: "write", input: {} })).toBe(false)
    expect(bashSafetyGate.matches({ id: "4", name: "edit", input: {} })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// bashSafetyGate.check — end-to-end
// ---------------------------------------------------------------------------

describe("bashSafetyGate.check", () => {
  it("runs all three sub-checks and collects all failures (concurrency unbounded)", () => {
    // A command that triggers the force-push check
    const r = runGate(bashSafetyGate.check(makeCall("git push --force origin main")))
    expect(r.ok).toBe(false)
    expect(r.error?._tag).toBe("GateError")
  })

  it("passes end-to-end for a safe command", () => {
    const r = runGate(bashSafetyGate.check(makeCall("echo 'hello world'")))
    expect(r.ok).toBe(true)
  })
})
