import React, { useState, useCallback, useRef, useEffect } from "react"
import { useKeyboard, useRenderer } from "@opentui/react"
import { Effect } from "effect"
import { join } from "node:path"
import { run, type ChatEvent } from "../agent/Loop.js"
import { runSkill, type HITLCallback } from "../machine/Runner.js"
import { getProviderConfig } from "../config/GatesConfig.js"

// ── intent routing ────────────────────────────────────────────────────────────

type Intent =
  | { type: "skill"; skillName: "solve-issue" | "write-tests"; arg: string }
  | { type: "freeform"; arg: string }

const classifyIntent = (text: string): Intent => {
  const t = text.trim()
  if (/^\d+$/.test(t))                                                  return { type: "skill", skillName: "solve-issue", arg: t }
  if (/^solve(-issue)?\s+/i.test(t))                                    return { type: "skill", skillName: "solve-issue", arg: t.replace(/^solve(-issue)?\s+/i, "") }
  if (/^(write-tests?|test)\s+/i.test(t))                               return { type: "skill", skillName: "write-tests", arg: t.replace(/^(write-tests?|test)\s+/i, "") }
  if (/\b(fix|add|implement|create|refactor|build|migrate)\b/i.test(t) && t.length > 20)
                                                                          return { type: "skill", skillName: "solve-issue", arg: t }
  return { type: "freeform", arg: t }
}

const resolveSkillPath = (skillName: string): string =>
  join(__dirname, "..", "..", "skills", skillName, "skill.yaml")

const toolSummary = (name: string, input: unknown): string => {
  const inp = input as Record<string, unknown>
  const hint =
    name === "read"       ? String(inp.path ?? "") :
    name === "read_lines" ? `${inp.path}:${inp.start}-${inp.end}` :
    name === "edit"       ? String(inp.path ?? "") :
    name === "write"      ? String(inp.path ?? "") :
    name === "bash"       ? String(inp.command ?? "").slice(0, 40) :
    name === "glob"       ? String(inp.pattern ?? "") :
    name === "grep"       ? `"${inp.pattern}" ${inp.path}` :
    name === "fetch"      ? String(inp.url ?? "").replace(/^https?:\/\//, "").slice(0, 40) :
    JSON.stringify(inp).slice(0, 40)
  return `${name}(${hint})`
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
  const [input, setInput]   = useState("")
  const [msgs, setMsgs]     = useState<Msg[]>([])
  const [liveLines, setLiveLines] = useState<Array<{ icon: string; text: string; dim: boolean }>>([])
  const MAX_LIVE = 5
  const [status, setStatus] = useState<"idle" | "thinking" | "hitl">("idle")
  const [currentState, setCurrentState] = useState<{ name: string; step: number; total: number } | null>(null)
  const [hitl, setHitl]     = useState<{ state: string; output: unknown; isError: boolean; resolve: (v: boolean) => void } | null>(null)
  const [runStats, setRunStats] = useState<{ totalIn: number; totalOut: number; startMs: number } | null>(null)
  const [modelInfo, setModelInfo] = useState<string>("")
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
    if (key.name === "escape" || (key.ctrl && key.name === "c")) renderer.destroy()
  })

  const chatHITL = useCallback((state: string, output: unknown, isError = false): Promise<boolean> =>
    new Promise(resolve => { setStatus("hitl"); setHitl({ state, output, isError, resolve }) }), [])

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim() || status !== "idle") return

    const intent = classifyIntent(value.trim())
    setMsgs(prev => [...prev, { id: String(++idRef.current), role: "user", text: value.trim(), tools: [] }])
    setStatus("thinking")
    setLiveLines([{ icon: "⟳", text: "thinking…", dim: true }])
    setRunStats({ totalIn: 0, totalOut: 0, startMs: Date.now() })
    setInput("")

    const tools: Array<{ text: string; isGate: boolean }> = []

    const stripThinking = (text: string) =>
      text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()

    const sanitizeForTUI = (text: string, maxLines = 12): string => {
      const cols = (process.stdout.columns ?? 80) - 8
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
        const s = toolSummary(ev.name, ev.input)
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
        // Route to runSkill — full state machine with HITL and onEvent
        const inputs: Record<string, string> = { issue: intent.arg }
        const skillResult = await runEffect(
          runSkill(skillPath, inputs, systemPrompt, false, chatHITL, onEvent) as unknown as Effect.Effect<Record<string, { output: unknown }>, never, never>
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
        // Route to run — direct agent execution (no state machine)
        result = await runEffect(
          run(intent.arg, systemPrompt, undefined, false, onEvent) as unknown as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
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
      const errText =
        e instanceof Error ? e.message :
        typeof e === "object" && e !== null && "cause" in e ? String((e as { cause: unknown }).cause) :
        typeof e === "object" && e !== null && "reason" in e ? String((e as { reason: unknown }).reason) :
        typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) :
        typeof e === "object" ? JSON.stringify(e) :
        String(e)
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

  const rows = process.stdout.rows ?? 24
  const cols = process.stdout.columns ?? 80
  const HEADER_H = 3   // 1 padding + 1 text + 1 border
  const INPUT_H = 3    // 1 border top + 1 text + 1 border bottom
  const STATS_H = statsBar ? 1 : 0
  const scrollH = rows - HEADER_H - INPUT_H - STATS_H

  return (
    <box flexDirection="column" height={rows} width={cols}>

      {/* header — fixed 3 rows */}
      <box flexDirection="row" height={HEADER_H} paddingX={1} paddingY={1} gap={2} border={["bottom"]} borderStyle="single">
        <text><b fg="#00CFCF">gates</b></text>
        <text fg="#555555">{statusText}</text>
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
                    <text fg={t.isGate ? "#FF6666" : "#555555"}>{t.text}</text>
                  </box>
                ))}
                <box flexDirection="row" gap={1}>
                  <text fg={msg.error ? "#FF4444" : "#44AA44"}>{msg.error ? "✗" : "●"}</text>
                  <text width={process.stdout.columns - 6}>{msg.text}</text>
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
                <text fg={line.icon === "⛔" ? "#FF6666" : line.dim ? "#444444" : "#666666"}>
                  {line.text}
                </text>
              </box>
            ))}
          </box>
        )}
      </scrollbox>

      {/* HITL overlay — plan approval or error escalation */}
      {status === "hitl" && hitl && (
        <box
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={hitl.isError ? "#FF4444" : "#AA44FF"}
          paddingX={2}
          paddingY={1}
          marginX={2}
          marginBottom={1}
        >
          <text><b fg={hitl.isError ? "#FF4444" : "#AA44FF"}>
            {hitl.isError ? "🚨  Error — state: " : "✋  Approval required — state: "}{hitl.state}
          </b></text>
          <text fg="#333333">{"─".repeat((process.stdout.columns ?? 80) - 8)}</text>
          <text>{JSON.stringify(hitl.output, null, 2)}</text>
          <text fg="#333333">{"─".repeat((process.stdout.columns ?? 80) - 8)}</text>
          <box flexDirection="row" gap={3} marginTop={1}>
            <text><b fg="#44AA44">[Y] {hitl.isError ? "Retry" : "Proceed"}</b></text>
            <text><b fg="#FF4444">[N] {hitl.isError ? "Skip state" : "Abort"}</b></text>
          </box>
        </box>
      )}

      {/* status bar — token usage + elapsed time + provider:model */}
      {statsBar && (
        <box flexDirection="row" paddingX={2} height={1}>
          <box flexGrow={1} />
          <text fg="#444444">{statsBar}</text>
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
