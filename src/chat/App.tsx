import React, { useState, useCallback, useRef } from "react"
import { Box, Text, useApp, useInput, Static } from "ink"
import TextInput from "ink-text-input"
import { Effect } from "effect"
import { run, type ChatEvent } from "../agent/Loop.js"
import type { Message } from "../services/LLM.js"

type IntentMode = "qa" | "skill"
type SkillName = "solve-issue" | "write-tests"

const classifyIntent = (text: string): { mode: IntentMode; skill?: SkillName; arg: string } => {
  const trimmed = text.trim()

  // GitHub issue number → solve-issue
  if (/^\d+$/.test(trimmed)) {
    return { mode: "skill", skill: "solve-issue", arg: trimmed }
  }

  // Explicit skill prefix
  if (trimmed.startsWith("solve-issue ") || trimmed.startsWith("solve ")) {
    return { mode: "skill", skill: "solve-issue", arg: trimmed.replace(/^solve(-issue)?\s+/, "") }
  }
  if (trimmed.startsWith("write-tests ") || trimmed.startsWith("test ")) {
    return { mode: "skill", skill: "write-tests", arg: trimmed.replace(/^(write-tests|test)\s+/, "") }
  }

  // Action keywords → suggest skill
  const actionPattern = /\b(fix|add|implement|create|refactor|update|remove|delete|migrate|build)\b/i
  if (actionPattern.test(trimmed) && trimmed.length > 20) {
    return { mode: "skill", skill: "solve-issue", arg: trimmed }
  }

  return { mode: "qa", arg: trimmed }
}

interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  content: string
  toolCalls?: Array<{ name: string; preview: string }>
  usage?: { input_tokens: number; output_tokens: number }
}

interface LiveEvent {
  type: "tool_call" | "tool_result" | "thinking"
  text: string
}

interface AppProps {
  appLayer: Effect.Effect<never, never, never> extends Effect.Effect<never, never, infer R> ? R : never
  runEffect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  systemPrompt?: string
}

export const App = ({ runEffect, systemPrompt }: {
  runEffect: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
  systemPrompt?: string
}) => {
  const { exit } = useApp()
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([])
  const [status, setStatus] = useState<"idle" | "thinking" | "hitl">("idle")
  const [hitlData, setHitlData] = useState<{ state: string; output: unknown; resolve: (v: boolean) => void } | null>(null)
  const historyRef = useRef<Message[]>([])
  const msgIdRef = useRef(0)

  useInput((ch, key) => {
    if (status === "hitl" && hitlData) {
      if (ch === "y" || ch === "Y" || key.return) { hitlData.resolve(true); setHitlData(null); setStatus("thinking") }
      if (ch === "n" || ch === "N") { hitlData.resolve(false); setHitlData(null); setStatus("idle") }
      return
    }
    if (key.escape || (key.ctrl && input === "")) exit()
  })

  const chatHITL = useCallback((state: string, output: unknown): Promise<boolean> => {
    return new Promise((resolve) => {
      setStatus("hitl")
      setHitlData({ state, output, resolve })
    })
  }, [])

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim() || status !== "idle") return
    setInput("")

    const intent = classifyIntent(value.trim())

    const userMsg: DisplayMessage = {
      id: String(++msgIdRef.current),
      role: "user",
      content: intent.mode === "skill"
        ? `[${intent.skill}] ${value.trim()}`
        : value.trim(),
    }
    setMessages((prev) => [...prev, userMsg])
    setStatus("thinking")
    setLiveEvents([])

    const toolCalls: Array<{ name: string; preview: string }> = []

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "tool_call") {
        const preview = JSON.stringify(ev.input).slice(0, 60)
        toolCalls.push({ name: ev.name, preview })
        setLiveEvents((prev) => [...prev, { type: "tool_call", text: `${ev.name}(${preview})` }])
      }
      if (ev.type === "tool_result") {
        setLiveEvents((prev) => [...prev, { type: "tool_result", text: ev.content.slice(0, 80) }])
      }
    }

    historyRef.current = [
      ...historyRef.current,
      { role: "user" as const, content: value.trim() },
    ]

    try {
      const result = await runEffect(
        run(value.trim(), systemPrompt, undefined, false, onEvent) as unknown as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>
      )

      historyRef.current = [
        ...historyRef.current,
        { role: "assistant" as const, content: [] },
      ]

      const assistantMsg: DisplayMessage = {
        id: String(++msgIdRef.current),
        role: "assistant",
        content: result.text || "(no response)",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: result.usage,
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch (e) {
      const errMsg: DisplayMessage = {
        id: String(++msgIdRef.current),
        role: "assistant",
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
      }
      setMessages((prev) => [...prev, errMsg])
    }

    setLiveEvents([])
    setStatus("idle")
  }, [status, runEffect, systemPrompt])

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="cyan" bold>gates</Text>
        <Text color="gray"> — autonomous coding agent  </Text>
        <Text color="gray" dimColor>ESC or Ctrl+C to exit</Text>
      </Box>

      {/* Completed messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        <Static items={messages}>
          {(msg) => (
            <Box key={msg.id} flexDirection="column" marginBottom={1}>
              {msg.role === "user" ? (
                <Box>
                  <Text color="blue" bold>▶ </Text>
                  <Text>{msg.content}</Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {msg.toolCalls?.map((tc, i) => (
                    <Box key={i}>
                      <Text color="yellow" dimColor>  ⚙ {tc.name}</Text>
                      <Text color="gray" dimColor>({tc.preview})</Text>
                    </Box>
                  ))}
                  <Box>
                    <Text color="green" bold>● </Text>
                    <Text wrap="wrap">{msg.content}</Text>
                  </Box>
                  {msg.usage && (
                    <Text color="gray" dimColor>
                      {"  "}{msg.usage.input_tokens} in / {msg.usage.output_tokens} out
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Static>

        {/* Live events while thinking */}
        {status === "thinking" && (
          <Box flexDirection="column">
            <Text color="yellow">⟳ thinking...</Text>
            {liveEvents.slice(-4).map((ev, i) => (
              <Text key={i} color={ev.type === "tool_call" ? "yellow" : "gray"} dimColor>
                {"  "}{ev.type === "tool_call" ? "⚙" : "→"} {ev.text}
              </Text>
            ))}
          </Box>
        )}

        {/* HITL Gate — approval prompt */}
        {status === "hitl" && hitlData && (
          <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1} marginTop={1}>
            <Text color="magenta" bold>✋ HITL Gate — human approval required</Text>
            <Text color="gray" dimColor>State: {hitlData.state}</Text>
            <Box flexDirection="column" marginY={1}>
              <Text>{JSON.stringify(hitlData.output, null, 2)}</Text>
            </Box>
            <Text color="magenta">Proceed with this plan? </Text>
            <Text color="green" bold>[Y]es</Text>
            <Text> / </Text>
            <Text color="red" bold>[N]o — abort</Text>
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box
        borderStyle="single"
        borderColor={status === "hitl" ? "magenta" : status === "thinking" ? "yellow" : "green"}
        paddingX={1}
      >
        <Text color={status === "hitl" ? "magenta" : status === "thinking" ? "yellow" : "green"}>
          {status === "hitl" ? "? " : "› "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={
            status === "hitl" ? "press Y to approve or N to reject" :
            status === "thinking" ? "waiting..." :
            "ask anything · solve-issue · write-tests · #42"
          }
        />
      </Box>
    </Box>
  )
}
