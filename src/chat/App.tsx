import React, { useState, useCallback, useRef } from "react"
import { Box, Text, useApp, useInput, Static } from "ink"
import TextInput from "ink-text-input"
import { Effect } from "effect"
import { run, type ChatEvent } from "../agent/Loop.js"
import type { Message } from "../services/LLM.js"

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
  const [status, setStatus] = useState<"idle" | "thinking">("idle")
  const historyRef = useRef<Message[]>([])
  const msgIdRef = useRef(0)

  useInput((_, key) => {
    if (key.escape || (key.ctrl && input === "")) exit()
  })

  const handleSubmit = useCallback(async (value: string) => {
    if (!value.trim() || status === "thinking") return
    setInput("")

    const userMsg: DisplayMessage = {
      id: String(++msgIdRef.current),
      role: "user",
      content: value.trim(),
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
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor={status === "thinking" ? "yellow" : "green"} paddingX={1}>
        <Text color={status === "thinking" ? "yellow" : "green"}>{"› "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={status === "thinking" ? "waiting..." : "ask anything or describe a task"}
        />
      </Box>
    </Box>
  )
}
