#!/usr/bin/env bun
import React, { useState, useCallback, useRef } from "react"
import { Box, Text, useApp, useInput, Static } from "ink"
import TextInput from "ink-text-input"
import { Effect } from "effect"
import { run, type ChatEvent } from "../agent/Loop.js"
import type { Message } from "../services/LLM.js"

// ── intent routing ────────────────────────────────────────────────────────────

type IntentMode = "qa" | "skill"
type SkillName = "solve-issue" | "write-tests"

const classifyIntent = (text: string): { mode: IntentMode; skill?: SkillName; arg: string } => {
  const t = text.trim()
  if (/^\d+$/.test(t))                                         return { mode: "skill", skill: "solve-issue", arg: t }
  if (/^solve(-issue)?\s+/i.test(t))                          return { mode: "skill", skill: "solve-issue", arg: t.replace(/^solve(-issue)?\s+/i, "") }
  if (/^(write-tests?|test)\s+/i.test(t))                     return { mode: "skill", skill: "write-tests", arg: t.replace(/^(write-tests?|test)\s+/i, "") }
  if (/\b(fix|add|implement|create|refactor|build|migrate)\b/i.test(t) && t.length > 20)
                                                                return { mode: "skill", skill: "solve-issue", arg: t }
  return { mode: "qa", arg: t }
}

// ── types ─────────────────────────────────────────────────────────────────────

interface Msg {
  id: string
  role: "user" | "assistant"
  text: string
  tools: string[]   // collapsed one-liners: "⚙ read(src/foo.ts)"
  usage?: { input_tokens: number; output_tokens: number }
  error?: boolean
}

interface Live {
  icon: string
  text: string
}

// ── helpers ───────────────────────────────────────────────────────────────────

const cols = () => process.stdout.columns ?? 80
const rule = () => "─".repeat(cols())

const toolSummary = (name: string, input: unknown): string => {
  const inp = input as Record<string, unknown>
  const hint =
    name === "read"      ? (inp.path as string ?? "") :
    name === "read_lines"? `${inp.path}:${inp.start}-${inp.end}` :
    name === "edit"      ? (inp.path as string ?? "") :
    name === "write"     ? (inp.path as string ?? "") :
    name === "bash"      ? ((inp.command as string ?? "").slice(0, 40)) :
    name === "glob"      ? (inp.pattern as string ?? "") :
    name === "grep"      ? `"${inp.pattern}" ${inp.path}` :
    name === "fetch"     ? (inp.url as string ?? "").replace(/^https?:\/\//, "") :
    name.startsWith("gh_") ? JSON.stringify(inp).slice(0, 40) :
    JSON.stringify(inp).slice(0, 40)
  return `${name}(${hint})`
}

// ── component ─────────────────────────────────────────────────────────────────

export const App = ({ runEffect, systemPrompt }: {
  runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
  systemPrompt?: string
}) => {
  const { exit } = useApp()
  const [input, setInput]         = useState("")
  const [msgs, setMsgs]           = useState<Msg[]>([])
  const [live, setLive]           = useState<Live[]>([])
  const [status, setStatus]       = useState<"idle" | "thinking" | "hitl">("idle")
  const [hitl, setHitl]           = useState<{ state: string; output: unknown; resolve: (v: boolean) => void } | null>(null)
  const _history                  = useRef<Message[]>([])
  const idRef                     = useRef(0)

  useInput((ch, key) => {
    if (status === "hitl" && hitl) {
      if (ch === "y" || ch === "Y" || key.return) { hitl.resolve(true);  setHitl(null); setStatus("thinking") }
      if (ch === "n" || ch === "N" || key.escape) { hitl.resolve(false); setHitl(null); setStatus("idle") }
      return
    }
    if (key.escape || (key.ctrl && ch === "c" && !input)) exit()
  })

  const chatHITL = useCallback((state: string, output: unknown): Promise<boolean> =>
    new Promise(resolve => { setStatus("hitl"); setHitl({ state, output, resolve }) }), [])

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim() || status !== "idle") return
    setInput("")

    const intent = classifyIntent(value.trim())
    const userMsg: Msg = { id: String(++idRef.current), role: "user", text: value.trim(), tools: [] }
    setMsgs(prev => [...prev, userMsg])
    setStatus("thinking")
    setLive([{ icon: "⟳", text: "thinking…" }])

    const toolLines: string[] = []
    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "tool_call") {
        const summary = toolSummary(ev.name, ev.input)
        toolLines.push(summary)
        setLive([{ icon: "⚙", text: summary }])
      }
      if (ev.type === "gate_block") {
        const blocked = `⛔ gate:${ev.gate}  ${ev.reason}`
        toolLines.push(blocked)
        setLive([{ icon: "⛔", text: `gate:${ev.gate} blocked` }])
      }
    }

    try {
      const result = await runEffect(
        run(intent.arg, systemPrompt, undefined, false, onEvent) as unknown as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
      )
      const assistantMsg: Msg = {
        id: String(++idRef.current),
        role: "assistant",
        text: result.text || "(no response)",
        tools: [...toolLines],
        usage: result.usage,
      }
      setMsgs(prev => [...prev, assistantMsg])
    } catch (e) {
      setMsgs(prev => [...prev, {
        id: String(++idRef.current),
        role: "assistant",
        text: e instanceof Error ? e.message : String(e),
        tools: [],
        error: true,
      }])
    }

    setLive([])
    setStatus("idle")
  }, [status, runEffect, systemPrompt])

  const borderColor = status === "hitl" ? "magenta" : status === "thinking" ? "yellow" : "green"

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>

      {/* ── header ── */}
      <Box paddingX={1} marginBottom={1}>
        <Text bold color="cyan">gates</Text>
        <Text color="gray">  {
          status === "hitl"     ? "waiting for approval — Y/N" :
          status === "thinking" ? "thinking…" :
          "ready  ·  ESC to exit"
        }</Text>
      </Box>

      {/* ── messages (static = no re-render flicker) ── */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        <Static items={msgs}>
          {(msg) => (
            <Box key={msg.id} flexDirection="column" marginBottom={1}>
              {msg.role === "user" ? (
                <Box gap={1}>
                  <Text color="blue">▶</Text>
                  <Text>{msg.text}</Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {/* collapsed tool + gate badges */}
                  {msg.tools.length > 0 && (
                    <Box flexDirection="column">
                      {msg.tools.map((t, i) => {
                        const isGate = t.startsWith("⛔")
                        return (
                          <Box key={i} gap={1}>
                            <Text color={isGate ? "red" : "yellow"} dimColor>  {isGate ? "⛔" : "⚙"}</Text>
                            <Text color={isGate ? "red" : "gray"} dimColor>{isGate ? t.slice(2) : t}</Text>
                          </Box>
                        )
                      })}
                    </Box>
                  )}
                  {/* response */}
                  <Box gap={1} marginTop={msg.tools.length > 0 ? 0 : undefined}>
                    <Text color={msg.error ? "red" : "green"}>{msg.error ? "✗" : "●"}</Text>
                    <Text wrap="wrap">{msg.text}</Text>
                  </Box>
                  {/* token line */}
                  {msg.usage && (
                    <Text color="gray" dimColor>
                      {"    "}{msg.usage.input_tokens} in / {msg.usage.output_tokens} out
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Static>

        {/* live indicator */}
        {status === "thinking" && live[0] && (
          <Box gap={1}>
            <Text color="yellow">{live[0].icon}</Text>
            <Text color="gray" dimColor>{live[0].text}</Text>
          </Box>
        )}
      </Box>

      {/* ── HITL overlay ── */}
      {status === "hitl" && hitl && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="magenta"
          paddingX={2}
          paddingY={1}
          marginX={1}
        >
          <Text color="magenta" bold>✋  Human approval required — state: {hitl.state}</Text>
          <Text>{rule()}</Text>
          <Text>{JSON.stringify(hitl.output, null, 2)}</Text>
          <Text>{rule()}</Text>
          <Box gap={2} marginTop={1}>
            <Text color="green" bold>[Y] Proceed</Text>
            <Text color="red" bold>[N] Abort</Text>
          </Box>
        </Box>
      )}

      {/* ── input ── */}
      <Box
        borderStyle="single"
        borderColor={borderColor}
        paddingX={1}
        marginX={1}
        marginBottom={0}
      >
        <Text color={borderColor}>› </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={
            status === "hitl"     ? "press Y or N" :
            status === "thinking" ? "" :
            "#42  ·  solve-issue …  ·  write-tests …  ·  or ask anything"
          }
        />
      </Box>

    </Box>
  )
}
