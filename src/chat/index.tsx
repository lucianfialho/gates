import React from "react"
import { render } from "ink"
import { Effect, Layer } from "effect"
import { App } from "./App.js"

type RunFn = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>

export const startChat = async (appLayer: Layer.Layer<never>, systemPrompt?: string) => {
  const runEffect: RunFn = (effect) => Effect.runPromise(effect)

  const { waitUntilExit } = render(
    <App
      runEffect={runEffect as never}
      {...(systemPrompt ? { systemPrompt } : {})}
    />,
    { exitOnCtrlC: true }
  )

  await waitUntilExit()
}
