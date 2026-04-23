import React from "react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Effect, Layer } from "effect"
import { App } from "./App.js"

export const startChat = async (appLayer: Layer.Layer<never>, systemPrompt?: string) => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  const root = createRoot(renderer)

  // Every effect from the chat gets the full app layer provided
  const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(Effect.provide(appLayer as Layer.Layer<never, never, never>))
    )

  root.render(
    <App
      runEffect={runEffect as never}
      {...(systemPrompt ? { systemPrompt } : {})}
    />
  )

  await new Promise<void>(resolve => {
    renderer.on("destroy", resolve)
  })
}
