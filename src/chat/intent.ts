import { join } from "node:path"
import type { Effect } from "effect"
import { run } from "../agent/Loop.js"

// ── intent routing ────────────────────────────────────────────────────────────

export type Mode = "read" | "patch" | "standard"

export type Intent =
  | { type: "skill"; skillName: "solve-issue" | "write-tests"; arg: string }
  | { type: "freeform"; arg: string }
  | { type: "mode-switch"; mode: Mode }

// Mode system prompts — injected based on active mode
export const MODE_SYSTEM: Record<Mode, string> = {
  read:     "You are in READ-ONLY mode. You may read files and answer questions but MUST NOT edit, write, or commit any files. If asked to change something, explain what would need to change without doing it.",
  patch:    "You are in PATCH mode. Make minimal, targeted changes only. Prefer editing existing code over rewriting. No new files unless strictly necessary.",
  standard: "",
}

// ── Pattern-based detection (zero tokens) ─────────────────────────────────────

type DetectedMode = "proRN" | "patch" | "standard"

const ENGLISH_PATTERNS = {
  proRN: [
    /^(what|how|why|when|where|who|which|can you|could you|do you|does|is|are)\b/i,
    /\b(explain|describe|show me|list|tell me|find|look at|check|review|understand|what is|what are)\b/i,
    /\?$/,
  ],
  standard: [
    /\b(add|create|implement|build|develop|make|generate|design|architect|refactor)\b/i,
    /\b(feature|functionality|system|module|component|service|skill|capability)\b/i,
  ],
  patch: [
    /\b(fix|correct|rename|move|update|change|modify|adjust|tweak|small|minor|quick)\b/i,
    /\b(typo|typos|spelling|bug|error|wrong|incorrect|broken|issue)\b/i,
  ],
}

const PORTUGUESE_PATTERNS = {
  proRN: [
    /^(o que|como|por que|quando|onde|quem|qual|você pode|consegue|faz|é|são)\b/i,
    /\b(explica|descreve|mostra|lista|me diz|encontra|olha|verifica|revisa|entende|o que é|quais são)\b/i,
  ],
  standard: [
    /\b(adiciona|cria|implementa|constrói|desenvolve|faz|gera|projeta|refatora)\b/i,
    /\b(funcionalidade|sistema|módulo|componente|serviço|habilidade|capacidade)\b/i,
  ],
  patch: [
    /\b(corrige|corrija|renomeia|move|atualiza|muda|modifica|ajusta|pequeno|menor|rápido)\b/i,
    /\b(erro|errado|incorreto|quebrado|problema)\b/i,
  ],
}

export const detectModeFromPatterns = (text: string): DetectedMode | null => {
  const t = text.trim()

  // proRN: questions, explanations, read operations
  const proRN = [...ENGLISH_PATTERNS.proRN, ...PORTUGUESE_PATTERNS.proRN]
  if (proRN.some(p => p.test(t))) return "proRN"

  // STANDARD: major features, new functionality (requires length > 25)
  const standard = [...ENGLISH_PATTERNS.standard, ...PORTUGUESE_PATTERNS.standard]
  if (standard.some(p => p.test(t)) && t.length > 25) return "standard"

  // PATCH: small targeted changes (requires length < 120)
  const patch = [...ENGLISH_PATTERNS.patch, ...PORTUGUESE_PATTERNS.patch]
  if (patch.some(p => p.test(t)) && t.length < 120) return "patch"

  return null  // ambiguous — needs LLM
}

// ── LLM classification (~200 tokens) ────────────────────────────────────────────

export const detectModeWithLLM = async (
  text: string,
  runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
): Promise<"proRN" | "patch" | "standard"> => {
  try {
    const prompt = `Classify this developer message into ONE mode. Reply with only the mode name.

Modes:
- proRN: question, explanation request, or read-only ("what does X do?", "how does Y work?")
- patch: small targeted code change ("fix typo", "rename variable", "update one line")
- standard: feature addition or major change ("add command", "implement feature", "create system")

Message: "${text.slice(0, 300)}"

Reply:`
    const result = await runEffect(
      run(prompt, "Reply with only: proRN, patch, or standard") as unknown as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
    )
    const r = result.text.toLowerCase().trim()
    if (r.includes("patch")) return "patch"
    if (r.includes("standard")) return "standard"
    return "proRN"
  } catch {
    return "proRN"  // safe default
  }
}

// ── Explicit command parsing ──────────────────────────────────────────────────

export const classifyExplicit = (text: string): Intent | null => {
  const t = text.trim()

  // Mode switches
  if (t === "@read"     || t.startsWith("@read "))     return { type: "mode-switch", mode: "read" }
  if (t === "@patch"    || t.startsWith("@patch "))    return { type: "mode-switch", mode: "patch" }
  if (t === "@standard" || t.startsWith("@standard ")) return { type: "mode-switch", mode: "standard" }

  // Refactor skill
  if (t === "@refactor" || t.startsWith("@refactor ")) {
    const arg = t.replace(/^@refactor\s*/i, "").trim()
    if (!arg) return { type: "freeform", arg: "Usage: @refactor split <file>\nExample: @refactor split src/index.ts" }
    return { type: "skill", skillName: "refactor-decompose" as any, arg }
  }

  // Explicit skill triggers
  if (/^\/s\s+/i.test(t))           return { type: "skill", skillName: "solve-issue", arg: t.replace(/^\/s\s+/i, "") }
  if (/^\/solve\s+/i.test(t))       return { type: "skill", skillName: "solve-issue", arg: t.replace(/^\/solve\s+/i, "") }
  if (/^\/test\s+/i.test(t))        return { type: "skill", skillName: "write-tests", arg: t.replace(/^\/test\s+/i, "") }

  // GitHub issue number → always STANDARD
  if (/^\d+$/.test(t))              return { type: "skill", skillName: "solve-issue", arg: t }
  if (/^solve(-issue)?\s+/i.test(t)) return { type: "skill", skillName: "solve-issue", arg: t.replace(/^solve(-issue)?\s+/i, "") }
  if (/^(write-tests?|test)\s+/i.test(t)) return { type: "skill", skillName: "write-tests", arg: t.replace(/^(write-tests?|test)\s+/i, "") }

  return null
}

// ── Intent classification (synchronous fallback) ──────────────────────────────

export const classifyIntent = (text: string): Intent => {
  const explicit = classifyExplicit(text)
  if (explicit) return explicit

  const t = text.trim()
  if (/\b(fix|add|implement|create|refactor|build|migrate)\b/i.test(t) && t.length > 20)
    return { type: "skill", skillName: "solve-issue", arg: t }

  return { type: "freeform", arg: t }
}

// ── Skill helpers ──────────────────────────────────────────────────────────────

export const resolveSkillPath = (skillName: string): string =>
  join(process.cwd(), "skills", skillName, "skill.yaml")

// ── UI helpers (used in App.tsx) ──────────────────────────────────────────────

export const cwd = process.cwd()
export const shortPath = (p: unknown) =>
  String(p ?? "").replace(cwd + "/", "").replace(cwd, "").slice(0, 45)

export const toolSummary = (name: string, input: unknown, termCols = 80): string => {
  const inp = input as Record<string, unknown>
  const cols = termCols - 20
  const hint =
    name === "read"       ? shortPath(inp.path) :
    name === "read_lines" ? `${shortPath(inp.path)}:${inp.start}-${inp.end}` :
    name === "edit"       ? shortPath(inp.path) :
    name === "write"      ? shortPath(inp.path) :
    name === "bash"       ? String(inp.command ?? "").slice(0, 45) :
    name === "glob"       ? String(inp.pattern ?? "").slice(0, 30) :
    name === "grep"       ? `"${String(inp.pattern ?? "").slice(0, 20)}" ${shortPath(inp.path)}` :
    name === "fetch"      ? String(inp.url ?? "").replace(/^https?:\/\//, "").slice(0, 40) :
    JSON.stringify(inp).slice(0, 35)
  const full = `${name}(${hint})`
  return full.length > cols ? full.slice(0, cols - 1) + "…" : full
}
