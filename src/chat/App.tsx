import React, { useState, useCallback, useRef, useEffect } from "react"
import { useKeyboard, useRenderer, useOnResize } from "@opentui/react"
import { Effect } from "effect"
import { join } from "node:path"
import { run, type ChatEvent } from "../agent/Loop.js"
import { runSkill, type HITLCallback } from "../machine/Runner.js"
import { getProviderConfig } from "../config/GatesConfig.js"

// ── intent routing ────────────────────────────────────────────────────────────

export type Mode = "read" | "patch" | "standard"

type Intent =
  | { type: "skill"; skillName: "solve-issue" | "write-tests"; arg: string }
  | { type: "freeform"; arg: string }
  | { type: "mode-switch"; mode: Mode }

// Mode system prompts — injected based on active mode
const MODE_SYSTEM: Record<Mode, string> = {
  read:     "You are in READ-ONLY mode. You may read files and answer questions but MUST NOT edit, write, or commit any files. If asked to change something, explain what would need to change without doing it.",
  patch:    "You are in PATCH mode. Make minimal, targeted changes only. Prefer editing existing code over rewriting. No new files unless strictly necessary.",
  standard: "",
}

// ── Intent Execution Mode Selection ──────────────────────────────────────────
// Mirrors the Gateway in the reference diagram:
// ProRN (read-only Q&A) | PATCH (minor change) | STANDARD (full lifecycle)

// Step 1 — deterministic rules (zero tokens, language-agnostic patterns)
const detectModeFromPatterns = (t: string): "proRN" | "patch" | "standard" | null => {
  // ProRN: questions, explanations, read operations
  const proRN = [
    /^(what|how|why|when|where|who|which|can you|could you|do you|does|is|are)\b/i,
    /^(o que|como|por que|quando|onde|quem|qual|você pode|consegue|faz|é|são)\b/i,
    /\b(explain|describe|show me|list|tell me|find|look at|check|review|understand|what is|what are)\b/i,
    /\b(explica|descreve|mostra|lista|me diz|encontra|olha|verifica|revisa|entende|o que é|quais são)\b/i,
    /\?$/,  // ends with question mark
  ]
  if (proRN.some(p => p.test(t))) return "proRN"

  // STANDARD: major features, new functionality, solve issues
  const standard = [
    /\b(add|create|implement|build|develop|make|generate|design|architect|refactor)\b/i,
    /\b(adiciona|cria|implementa|constrói|desenvolve|faz|gera|projeta|refatora)\b/i,
    /\b(feature|functionality|system|module|component|service|skill|capability)\b/i,
    /\b(funcionalidade|sistema|módulo|componente|serviço|habilidade|capacidade)\b/i,
  ]
  if (standard.some(p => p.test(t)) && t.length > 25) return "standard"

  // PATCH: small targeted changes
  const patch = [
    /\b(fix|correct|rename|move|update|change|modify|adjust|tweak|small|minor|quick)\b/i,
    /\b(corrige|corrija|renomeia|move|atualiza|muda|modifica|ajusta|pequeno|menor|rápido)\b/i,
    /\b(typo|typos|spelling|bug|error|wrong|incorrect|broken|issue)\b/i,
    /\b(erro|errado|incorreto|quebrado|problema)\b/i,
  ]
  if (patch.some(p => p.test(t)) && t.length < 120) return "patch"

  return null  // ambiguous — needs LLM
}

// Step 2 — LLM classification for ambiguous messages (~200 tokens)
const detectModeWithLLM = async (
  text: string,
  runEffect: <A, E>(effect: import("effect").Effect.Effect<A, E, never>) => Promise<A>
): Promise<"proRN" | "patch" | "standard"> => {
  try {
    const { run } = await import("../agent/Loop.js")
    const prompt = `Classify this developer message into ONE mode. Reply with only the mode name.

Modes:
- proRN: question, explanation request, or read-only ("what does X do?", "how does Y work?")
- patch: small targeted code change ("fix typo", "rename variable", "update one line")
- standard: feature addition or major change ("add command", "implement feature", "create system")

Message: "${text.slice(0, 300)}"

Reply:`
    const result = await runEffect(
      run(prompt, "Reply with only: proRN, patch, or standard") as unknown as import("effect").Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
    )
    const r = result.text.toLowerCase().trim()
    if (r.includes("patch")) return "patch"
    if (r.includes("standard")) return "standard"
    return "proRN"
  } catch {
    return "proRN"  // safe default
  }
}

// Explicit commands — override auto-detection (zero cost, highest priority)
const classifyExplicit = (text: string): Intent | null => {
  const t = text.trim()
  // Mode switches — persist for session
  if (t === "@read"     || t.startsWith("@read "))     return { type: "mode-switch", mode: "read" }
  if (t === "@patch"    || t.startsWith("@patch "))    return { type: "mode-switch", mode: "patch" }
  if (t === "@standard" || t.startsWith("@standard ")) return { type: "mode-switch", mode: "standard" }
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

// LLM classify stub (kept for backwards compat — now uses detectModeWithLLM)
const classifyWithLLM = async (
  text: string,
  runEffect: <A, E>(effect: import("effect").Effect.Effect<A, E, never>) => Promise<A>
): Promise<Intent> => {
  try {
    const detected = await detectModeWithLLM(text, runEffect)
    if (detected === "standard") return { type: "skill", skillName: "solve-issue", arg: text }
    if (detected === "patch")    return { type: "freeform", arg: text }  // patch = freeform + patch mode
    return { type: "freeform", arg: text }
  } catch {
    return { type: "freeform", arg: text }
  }
}

// Synchronous fallback (English keywords only)
const classifyIntent = (text: string): Intent => {
  const explicit = classifyExplicit(text)
  if (explicit) return explicit
  const t = text.trim()
  if (/\b(fix|add|implement|create|refactor|build|migrate)\b/i.test(t) && t.length > 20)
    return { type: "skill", skillName: "solve-issue", arg: t }
  return { type: "freeform", arg: t }
}

const resolveSkillPath = (skillName: string): string =>
  join(process.cwd(), "skills", skillName, "skill.yaml")

// Strip cwd from paths so tool summaries stay short
const cwd = process.cwd()
const shortPath = (p: unknown) =>
  String(p ?? "").replace(cwd + "/", "").replace(cwd, "").slice(0, 45)

const toolSummary = (name: string, input: unknown, termCols = 80): string => {
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

// ── types ─────────────────────────────────────────────────────────────────────

interface Msg {
  id: string
  role: "user" | "assistant"
  text: string
  tools: Array<{ text: string; isGate: boolean }>
  usage?: { input_tokens: number; output_tokens: number }
  error?: boolean
}

// ── component ─────────────────────────────────────────────────────────────────

export const App = ({ runEffect, systemPrompt }: {
  runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
  systemPrompt?: string
}) => {
  const renderer = useRenderer()
  const [termSize, setTermSize] = useState({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  })
  useOnResize((w, h) => setTermSize({ cols: w, rows: h }))

  const [input, setInput]   = useState("")
  const [msgs, setMsgs]     = useState<Msg[]>([])
  const [liveLines, setLiveLines] = useState<Array<{ icon: string; text: string; dim: boolean }>>([])
  const MAX_LIVE = 5
  const [status, setStatus] = useState<"idle" | "thinking" | "hitl">("idle")
  const [currentState, setCurrentState] = useState<{ name: string; step: number; total: number } | null>(null)
  const [hitl, setHitl]     = useState<{ state: string; output: unknown; isError: boolean; resolve: (v: boolean) => void } | null>(null)
  const [runStats, setRunStats] = useState<{ totalIn: number; totalOut: number; startMs: number } | null>(null)
  const [modelInfo, setModelInfo] = useState<string>("")
  const [mode, setMode] = useState<Mode>("standard")
  const idRef               = useRef(0)

  // Load provider:model from config on mount
  useEffect(() => {
    getProviderConfig().then(cfg => setModelInfo(`${cfg.provider}:${cfg.model}`))
  }, [])

  useKeyboard((key) => {
    if (status === "hitl" && hitl) {
      if (key.name === "y" || key.name === "return") { hitl.resolve(true);  setHitl(null); setStatus("thinking") }
      if (key.name === "n" || key.name === "escape") { hitl.resolve(false); setHitl(null); setStatus("idle") }
      return
    }
    if (key.name === "return" && status === "idle" && input.trim()) {
      handleSubmit(input)
      return
    }
    if (key.ctrl && key.name === "k") {
      setMsgs([])
      setLiveLines([])
      setCurrentState(null)
      setRunStats(null)
      return
    }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) renderer.destroy()
  })

  const chatHITL = useCallback((state: string, output: unknown, isError = false): Promise<boolean> =>
    new Promise(resolve => { setStatus("hitl"); setHitl({ state, output, isError, resolve }) }), [])

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim() || status !== "idle") return

    // Intent Execution Mode Selection — 3 layers:
    // 1. Explicit commands (@, /s, #42) — zero tokens
    // 2. Deterministic patterns (questions, verbs) — zero tokens
    // 3. LLM classification for ambiguous — ~200 tokens
    const explicit = classifyExplicit(value.trim())
    let intent: Intent
    if (explicit) {
      intent = explicit
    } else {
      const detected = detectModeFromPatterns(value.trim())
      if (detected === "standard") {
        intent = { type: "skill", skillName: "solve-issue", arg: value.trim() }
      } else if (detected === "patch") {
        // PATCH: freeform agent with patch mode system prompt
        setMode("patch")
        intent = { type: "freeform", arg: value.trim() }
      } else if (detected === "proRN") {
        // ProRN: freeform agent with read-only mode
        setMode("read")
        intent = { type: "freeform", arg: value.trim() }
      } else {
        // Ambiguous → LLM classification (~200 tokens)
        const llmMode = await detectModeWithLLM(value.trim(), runEffect)
        if (llmMode === "standard") {
          intent = { type: "skill", skillName: "solve-issue", arg: value.trim() }
        } else {
          setMode(llmMode === "patch" ? "patch" : "read")
          intent = { type: "freeform", arg: value.trim() }
        }
      }
    }

    // Mode switch — no LLM call needed
    if (intent.type === "mode-switch") {
      setMode(intent.mode)
      setMsgs(prev => [...prev, {
        id: String(++idRef.current), role: "assistant",
        text: `Mode: ${intent.mode.toUpperCase()}${intent.mode === "read" ? " — read-only, no edits" : intent.mode === "patch" ? " — minimal targeted changes" : " — full lifecycle"}`,
        tools: [],
      }])
      setInput("")
      return
    }

    setMsgs(prev => [...prev, { id: String(++idRef.current), role: "user", text: value.trim(), tools: [] }])
    setStatus("thinking")
    setLiveLines([{ icon: "⟳", text: "thinking…", dim: true }])
    setRunStats({ totalIn: 0, totalOut: 0, startMs: Date.now() })
    setInput("")

    const tools: Array<{ text: string; isGate: boolean }> = []

    const stripThinking = (text: string) =>
      text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()

    const sanitizeForTUI = (text: string, maxLines = 12): string => {
      const cols = (termSize.cols) - 8
      return stripThinking(text)
        .replace(/```[\w]*\n([\s\S]+?)```/g, (_, code: string) =>
          code.trim().split("\n").slice(0, 4).map((l: string) => `  ${l}`).join("\n") +
          (code.split("\n").length > 4 ? "\n  …" : ""))
        .replace(/^#{1,3} /gm, "")          // strip headings
        .replace(/\*\*(.*?)\*\*/g, "$1")   // strip bold
        .replace(/\*(.*?)\*/g, "$1")       // strip italic
        .replace(/`([^`]+)`/g, "$1")       // strip inline code
        .replace(/^[-*] /gm, "• ")
        .split("\n")
        .map((l: string) => l.length > cols ? l.slice(0, cols - 1) + "…" : l)
        .slice(0, maxLines)
        .join("\n")
        .trim()
    }

    const addLive = (icon: string, text: string, dim = false) =>
      setLiveLines(prev => [...prev.slice(-(MAX_LIVE - 1)), { icon, text, dim }])

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "done") {
        setRunStats(prev => prev ? {
          ...prev,
          totalIn: prev.totalIn + ev.usage.input_tokens,
          totalOut: prev.totalOut + ev.usage.output_tokens,
        } : null)
      }
      if (ev.type === "state_change") {
        setCurrentState({ name: ev.state, step: ev.step, total: ev.total })
        addLive("◎", `[${ev.state}]  ${ev.step}/${ev.total}`, false)
      }
      if (ev.type === "thinking") {
        const cleaned = stripThinking(ev.text).slice(0, 100).replace(/\n/g, " ")
        if (cleaned) addLive("…", cleaned, true)
      }
      if (ev.type === "tool_call") {
        const s = toolSummary(ev.name, ev.input, termSize.cols)
        tools.push({ text: s, isGate: false })
        addLive("⚙", s)
      }
      if (ev.type === "gate_block") {
        const s = `gate:${ev.gate}  ${ev.reason}`
        tools.push({ text: s, isGate: true })
        addLive("⛔", s)
      }
    }

    // Resolve skill path if this is a skill intent
    const skillPath = intent.type === "skill" ? resolveSkillPath(intent.skillName) : null

    try {
      let result: { text?: string; usage: { input_tokens: number; output_tokens: number } }

      if (skillPath && intent.type === "skill") {
        // Capture recent conversation as context — replaces research rediscovery
        const chatContext = msgs
          .slice(-8)
          .filter(m => m.text.length > 20)
          .map(m => `${m.role === "user" ? "human" : "assistant"}: ${m.text.slice(0, 400)}`)
          .join("\n\n")

        const inputs: Record<string, string> = {
          issue: intent.arg,
          ...(chatContext ? { chat_context: chatContext } : {}),
        }
        const modePrompt = MODE_SYSTEM[mode]
        const effectiveSystem = [systemPrompt, modePrompt].filter(Boolean).join("\n\n") || undefined
        const skillResult = await runEffect(
          runSkill(skillPath, inputs, effectiveSystem, false, chatHITL, onEvent) as unknown as Effect.Effect<Record<string, { output: unknown }>, never, never>
        ) as Record<string, { output: unknown }>
        // Extract the last state's output as text
        const states = Object.keys(skillResult)
        const lastKey = states[states.length - 1]
        const last = lastKey ? skillResult[lastKey] : undefined
        result = {
          text: last ? JSON.stringify(last.output, null, 2) : "(no output)",
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      } else {
        // Route to run — direct agent execution with mode system prompt
        const modePrompt = MODE_SYSTEM[mode]
        const effectiveSystem = [systemPrompt, modePrompt].filter(Boolean).join("\n\n") || undefined
        result = await runEffect(
          run(intent.arg, effectiveSystem, undefined, false, onEvent) as unknown as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
        )
      }

      setMsgs(prev => [...prev, {
        id: String(++idRef.current),
        role: "assistant",
        text: result.text ? sanitizeForTUI(result.text) : "(no response)",
        tools: [...tools],
        usage: result.usage,
      }])
    } catch (e) {
      const formatErr = (err: unknown): string => {
        if (err instanceof Error) return err.message
        if (typeof err !== "object" || err === null) return String(err)
        const o = err as Record<string, unknown>
        // RunnerError / GateError / AgentError — Effect tagged errors
        if (o["_tag"] && o["reason"]) return `${o["_tag"]}: ${o["reason"]}${o["cause"] ? `\n  caused by: ${formatErr(o["cause"])}` : ""}`
        if (o["_tag"] && o["cause"])  return `${o["_tag"]}: ${formatErr(o["cause"])}`
        if (o["reason"])  return String(o["reason"])
        if (o["message"]) return String(o["message"])
        return JSON.stringify(err, null, 2).slice(0, 300)
      }
      const errText = formatErr(e)
      setMsgs(prev => [...prev, {
        id: String(++idRef.current),
        role: "assistant",
        text: errText,
        tools: [...tools],
        error: true,
      }])
    }

    setLiveLines([])
    setCurrentState(null)
    setStatus("idle")
  }, [status, runEffect, systemPrompt, chatHITL])

  const borderColor =
    status === "hitl"     ? "#AA44FF" :
    status === "thinking" ? "#AAAA00" : "#44AA44"

  const statusText =
    status === "hitl"     ? "approval required — Y / N" :
    status === "thinking" && currentState
      ? `[${currentState.name}]  ${currentState.step}/${currentState.total}` :
    status === "thinking" ? "thinking…" :
    "ready  ·  ESC to quit"

  // Compute elapsed and stats for the status bar
  const statsBar = (() => {
    if (!runStats) return null
    const elapsed = Math.floor((Date.now() - runStats.startMs) / 1000)
    const mins = Math.floor(elapsed / 60)
    const secs = elapsed % 60
    const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
    const { totalIn, totalOut } = runStats
    if (totalIn === 0 && totalOut === 0) return `  ⏱ ${elapsedStr}`
    // MiniMax pricing: $0.30/MTok in, $1.20/MTok out
    const cost = (totalIn / 1_000_000) * 0.30 + (totalOut / 1_000_000) * 1.20
    return `${(totalIn / 1000).toFixed(0)}k in · ${(totalOut / 1000).toFixed(0)}k out · ${cost.toFixed(2)} · ${elapsedStr}`
  })()

  const rows = termSize.rows
  const cols = termSize.cols
  const HEADER_H = 3   // 1 padding + 1 text + 1 border
  const INPUT_H = 3    // 1 border top + 1 text + 1 border bottom
  const STATS_H = statsBar ? 1 : 0
  const scrollH = rows - HEADER_H - INPUT_H - STATS_H

  return (
    <box flexDirection="column" height={rows} width={cols}>

      {/* header — fixed 3 rows */}
      <box flexDirection="row" height={HEADER_H} paddingX={1} paddingY={1} gap={2} border={["bottom"]} borderStyle="single">
        <text><b fg="#00CFCF">gates</b></text>
        <text fg={mode === "read" ? "#FF8844" : mode === "patch" ? "#AAAA00" : "#555555"}>
          {mode !== "standard" ? `@${mode}  ` : ""}{statusText}
        </text>
        <box flexGrow={1} />
        <text fg="#333333">@read · @patch · @standard</text>
      </box>

      {/* messages */}
      <scrollbox height={scrollH} paddingX={1} paddingY={1}>
        {msgs.map((msg) => (
          <box key={msg.id} flexDirection="column" marginBottom={1}>
            {msg.role === "user" ? (
              <box flexDirection="row" gap={1}>
                <text fg="#4488FF">▶</text>
                <text>{msg.text}</text>
              </box>
            ) : (
              <box flexDirection="column">
                {msg.tools.map((t, i) => (
                  <box key={i} flexDirection="row" gap={1}>
                    <text fg={t.isGate ? "#FF4444" : "#888800"}>  {t.isGate ? "⛔" : "⚙"}</text>
                    <text width={cols - 8} fg={t.isGate ? "#FF6666" : "#555555"}>{t.text}</text>
                  </box>
                ))}
                <box flexDirection="row" gap={1}>
                  <text fg={msg.error ? "#FF4444" : "#44AA44"}>{msg.error ? "✗" : "●"}</text>
                  <text width={termSize.cols - 6}>{msg.text}</text>
                </box>
                {msg.usage && (
                  <text fg="#444444">{"    "}{msg.usage.input_tokens} in / {msg.usage.output_tokens} out</text>
                )}
              </box>
            )}
          </box>
        ))}

        {/* live progress — rolling stream of thinking + tool calls */}
        {status === "thinking" && liveLines.length > 0 && (
          <box flexDirection="column">
            {liveLines.map((line, i) => (
              <box key={i} flexDirection="row" gap={1}>
                <text fg={line.icon === "⛔" ? "#FF4444" : line.dim ? "#444444" : "#888800"}>
                  {line.icon}
                </text>
                <text
                  width={cols - 6}
                  fg={line.icon === "⛔" ? "#FF6666" : line.dim ? "#444444" : "#666666"}
                >
                  {line.text}
                </text>
              </box>
            ))}
          </box>
        )}
      </scrollbox>

      {/* HITL overlay — readable PRP format */}
      {status === "hitl" && hitl && (() => {
        const o = hitl.output as Record<string, unknown> | null
        const isPRP = !hitl.isError && o && ("context" in o || "spec" in o)
        const ctx = isPRP ? o!["context"] as Record<string, unknown> : null
        const spec = isPRP ? o!["spec"] as Record<string, unknown> : null
        const acc = isPRP ? o!["acceptance"] as string[] | undefined : undefined
        const div = "─".repeat(Math.max(10, termSize.cols - 8))
        const files = ctx && Array.isArray(ctx["files"]) ? ctx["files"] as string[] : []
        const changes = spec && Array.isArray(spec["changes"]) ? spec["changes"] as Array<Record<string,unknown>> : []
        const constraints = spec && Array.isArray(spec["constraints"]) ? spec["constraints"] as string[] : []

        return (
          <box flexDirection="column" border borderStyle="rounded"
            borderColor={hitl.isError ? "#FF4444" : "#AA44FF"}
            paddingX={2} paddingY={1} marginX={2} marginBottom={1}>

            <text><b fg={hitl.isError ? "#FF4444" : "#AA44FF"}>
              {hitl.isError ? "🚨  Error" : "✋  Approve plan"} — {hitl.state}
            </b></text>
            <text fg="#555555">{div}</text>

            {isPRP && ctx ? (
              <box flexDirection="column">
                {!!o!["issue_title"] && <text fg="#CCCCCC"><b fg="#FFFFFF">Issue: </b>{String(o!["issue_title"])}</text>}
                {!!ctx["summary"] && <text fg="#CCCCCC"><b fg="#FFFFFF">Why: </b>{String(ctx["summary"])}</text>}
                {files.length > 0 && <box flexDirection="column">
                  <text><b fg="#FFFFFF">Files:</b></text>
                  {files.map((f, i) => <text key={i} fg="#88CCFF">  • {f}</text>)}
                </box>}
                {changes.length > 0 && <box flexDirection="column">
                  <text><b fg="#FFFFFF">Changes:</b></text>
                  {changes.map((c, i) => <text key={i} fg="#AAFFAA">  • {String(c["file"])}: {String(c["description"] ?? "").slice(0, termSize.cols - 20)}</text>)}
                </box>}
                {constraints.length > 0 && <box flexDirection="column">
                  <text><b fg="#FFFFFF">Constraints:</b></text>
                  {constraints.map((c, i) => <text key={i} fg="#FFCC88">  ⚠ {c.slice(0, termSize.cols - 20)}</text>)}
                </box>}
                {acc && acc.length > 0 && <box flexDirection="column">
                  <text><b fg="#FFFFFF">Acceptance:</b></text>
                  {acc.map((a, i) => <text key={i} fg="#88FF88">  ✓ {a.slice(0, termSize.cols - 20)}</text>)}
                </box>}
              </box>
            ) : (
              <text fg="#CCCCCC">{
                hitl.isError
                  ? String((o as Record<string,unknown> | null)?.["error"] ?? JSON.stringify(o).slice(0, 300))
                  : JSON.stringify(o, null, 2).slice(0, 400)
              }</text>
            )}

            <text fg="#555555">{div}</text>
            <box flexDirection="row" gap={3} marginTop={1}>
              <text><b fg="#44AA44">[Y] {hitl.isError ? "Retry" : "Approve & implement"}</b></text>
              <text><b fg="#FF4444">[N] {hitl.isError ? "Skip" : "Abort"}</b></text>
            </box>
          </box>
        )
      })()}

      {/* status bar — token usage + elapsed time + provider:model */}
      {(statsBar || modelInfo) && (
        <box flexDirection="row" paddingX={2} height={1}>
          <box flexGrow={1} />
          {statsBar && <text fg="#444444">{statsBar}</text>}
          {modelInfo && <><text fg="#444444"> · </text><text fg="#555555">{modelInfo}</text></>}
        </box>
      )}

      {/* input area — fixed 3 rows */}
      <box
        flexDirection="row"
        height={INPUT_H}
        border
        borderStyle="single"
        borderColor={borderColor}
        paddingX={1}
        marginX={1}
      >
        <text fg={borderColor}>› </text>
        <input
          flexGrow={1}
          value={input}
          onInput={setInput}
          focused={status === "idle"}
          placeholder={
            status === "hitl"     ? "Y or N" :
            status === "thinking" ? "..." :
            "ask anything, solve-issue 42, write-tests path"
          }
        />
      </box>

    </box>
  )
}
