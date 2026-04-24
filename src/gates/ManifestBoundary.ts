import { Effect } from "effect"
import { GateError, type Gate, type ToolCall } from "./Gate.js"
import { loadCurrentManifest } from "../context/ResearchManifest.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

/**
 * ManifestBoundary gate — autoresearch structural enforcement.
 *
 * When a research manifest exists (.gates/research-manifest.yaml),
 * blocks read() calls on files outside the manifest.
 * This mirrors autoresearch's output redirect: the agent CANNOT read
 * files outside the manifest, structurally — not via prompt suggestion.
 *
 * Only active during the research state (GATES_ACTIVE_STATE=research).
 * Cleared automatically when research completes.
 */
export const manifestBoundaryGate: Gate = {
  name: "manifest-boundary",
  matches: (call: ToolCall) => call.name === "read",
  check: (call: ToolCall) => {
    const activeState = process.env["GATES_ACTIVE_STATE"] ?? ""
    if (activeState !== "research") return pass  // only enforce during research

    const input = call.input as Record<string, unknown>
    const path = String(input["path"] ?? "")
    if (!path) return pass

    return Effect.gen(function* () {
      const manifest = yield* Effect.promise(() => loadCurrentManifest())
      if (!manifest || manifest.manifest.length === 0) return  // no manifest → pass

      const allowed = manifest.allowed_files
      const isAllowed = allowed.some(f =>
        path.endsWith(f) || f.endsWith(path) ||
        path.includes(f.replace(/^src\//, "")) ||
        f.includes(path.replace(/^.*src\//, "src/"))
      )

      if (!isAllowed) {
        yield* block(
          "manifest-boundary",
          `File "${path}" is outside the research manifest (${allowed.length} files allowed).\n` +
          `Allowed: ${allowed.slice(0, 5).join(", ")}${allowed.length > 5 ? "..." : ""}\n` +
          `Use execute_code to read files within the manifest only.`
        )
      }
    })
  },
}
