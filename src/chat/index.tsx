import React from "react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect } from "effect"
import { App } from "./App.js"

type RunFn = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>

export const startChat = async (_appLayer: unknown, systemPrompt?: string) => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const root = createRoot(renderer)
  const runEffect: RunFn = (effect) => Effect.runPromise(effect)

  root.render(
    <App
      runEffect={runEffect as never}
      {...(systemPrompt ? { systemPrompt } : {})}
    />
  )

  // Wait until the renderer is destroyed (ESC or Ctrl+C)
  await new Promise<void>(resolve => {
    renderer.on("destroy", resolve)
  })
}
