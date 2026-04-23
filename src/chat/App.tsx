import React, { useState, useCallback, useRef } from "react"
import { useKeyboard, useRenderer } from "@opentui/react"
import { Effect } from "effect"
import { run, type ChatEvent } from "../agent/Loop.js"

// ── intent routing ────────────────────────────────────────────────────────────

const classifyIntent = (text: string): { skill?: "solve-issue" | "write-tests"; arg: string } => {
  const t = text.trim()
  if (/^\d+$/.test(t))                                                  return { skill: "solve-issue", arg: t }
  if (/^solve(-issue)?\s+/i.test(t))                                    return { skill: "solve-issue", arg: t.replace(/^solve(-issue)?\s+/i, "") }
  if (/^(write-tests?|test)\s+/i.test(t))                               return { skill: "write-tests", arg: t.replace(/^(write-tests?|test)\s+/i, "") }
  if (/\b(fix|add|implement|create|refactor|build|migrate)\b/i.test(t) && t.length > 20)
                                                                          return { skill: "solve-issue", arg: t }
  return { arg: t }
}

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
  const [liveText, setLive] = useState("")
  const [status, setStatus] = useState<"idle" | "thinking" | "hitl">("idle")
  const [hitl, setHitl]     = useState<{ state: string; output: unknown; isError: boolean; resolve: (v: boolean) => void } | null>(null)
  const idRef               = useRef(0)

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
    setLive("thinking…")
    setInput("")

    const tools: Array<{ text: string; isGate: boolean }> = []

    // Strip <think>...</think> blocks from MiniMax reasoning output
    const stripThinking = (text: string) =>
      text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "thinking") {
        // Show first 80 chars of intermediate reasoning
        setLive(ev.text.slice(0, 80).replace(/\n/g, " "))
      }
      if (ev.type === "tool_call") {
        const s = toolSummary(ev.name, ev.input)
        tools.push({ text: s, isGate: false })
        setLive(`⚙ ${s}`)
      }
      if (ev.type === "gate_block") {
        const s = `gate:${ev.gate}  ${ev.reason}`
        tools.push({ text: s, isGate: true })
        setLive(`⛔ ${s}`)
      }
    }

    try {
      const result = await runEffect(
        run(intent.arg, systemPrompt, undefined, false, onEvent) as unknown as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
      )
      setMsgs(prev => [...prev, {
        id: String(++idRef.current),
        role: "assistant",
        text: stripThinking(result.text) || "(no response)",
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

    setLive("")
    setStatus("idle")
  }, [status, runEffect, systemPrompt, chatHITL])

  const borderColor =
    status === "hitl"     ? "#AA44FF" :
    status === "thinking" ? "#AAAA00" : "#44AA44"

  const statusText =
    status === "hitl"     ? "approval required — Y / N" :
    status === "thinking" ? "thinking…" :
    "ready  ·  ESC to quit"

  return (
    <box flexDirection="column" height={process.stdout.rows ?? 24} width={process.stdout.columns ?? 80}>

      {/* header */}
      <box flexDirection="row" padding={1} gap={2} border={["bottom"]} borderStyle="single">
        <text><b fg="#00CFCF">gates</b></text>
        <text fg="#555555">{statusText}</text>
      </box>

      {/* messages */}
      <scrollbox flexGrow={1} paddingX={1} paddingY={1}>
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

        {/* live progress indicator */}
        {status === "thinking" && liveText && (
          <box flexDirection="row" gap={1}>
            <text fg="#888800">⟳</text>
            <text fg="#555555">{liveText}</text>
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

      {/* input area */}
      <box
        flexDirection="row"
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
