import { Effect, Layer } from "effect"

import { GateRegistry } from "../services/GateRegistry.js"
import { bashSafetyGate } from "./BashSafety.js"
import { metadataGate } from "./Metadata.js"
import { selectiveContextGate } from "./ContextScope.js"
import { readLargeGate } from "./ReadLarge.js"
import { readDedupGate } from "./ReadDedup.js"
import { verifyReadOnlyGate } from "./VerifyReadOnly.js"
import { writeLargeGate } from "./WriteLarge.js"
import { workspaceBoundaryGate } from "./WorkspaceBoundary.js"
import { executeCodeEnforceGate } from "./ExecuteCodeEnforce.js"
import { manifestBoundaryGate } from "./ManifestBoundary.js"
import { issueReadGuardGate } from "./IssueReadGuard.js"
import type { GatesConfig } from "../config/GatesConfig.js"
import type { ProjectContext } from "../context/ProjectContext.js"

// Static gate list — used by doctor command without needing AppLayer
export const BUILTIN_GATE_NAMES = [
  "bash-safety", "metadata", "context-scope", "read-large",
  "read-dedup", "verify-readonly", "write-large", "workspace-boundary",
  "manifest-boundary", "issue-read-guard",
] as const

export const getBuiltinGateCount = (): number => BUILTIN_GATE_NAMES.length

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * BuiltinGatesLayer
 *
 * Registers the built-in gates (BashSafety, Metadata, SelectiveContext).
 * Gates that need config or context receive it as plain parameters at
 * registration time — no additional context services are required.
 *
 * Note: `config` and `ctx` are captured at registration. For `context_scope`
 * this is fine (static). For `ctx.phase`, the phase is read from the
 * relevant.json file at enforcement time, so the captured reference is not
 * needed for the phase check — only `config.context_scope` matters from the
 * captured config object.
 */
export const BuiltinGatesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* GateRegistry

    // The config and context are passed in when the gate is created;
    // selectiveContextGate reads the phase from relevant.json at enforcement time.
    registry.register(bashSafetyGate)
    registry.register(metadataGate)
    registry.register(selectiveContextGate)
    registry.register(readLargeGate)
    registry.register(readDedupGate)
    registry.register(verifyReadOnlyGate)
    registry.register(writeLargeGate)
    registry.register(workspaceBoundaryGate)
    registry.register(manifestBoundaryGate)
    registry.register(issueReadGuardGate)
    // executeCodeEnforceGate disabled — reactive gate creates more overhead than it saves.
    // Enforcement is done via system prompt instead (zero cost per compliance).
  })
)