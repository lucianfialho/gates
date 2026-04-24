#!/usr/bin/env bun
import { Effect } from "effect"
import { Auth, AuthLayer } from "../auth/Auth.js"

export const runAuth = (args: string[]) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const [sub, second, third] = args

    if (sub === "set") {
      // gates auth set <key>               → anthropic (default)
      // gates auth set <provider> <key>    → named provider
      const [provider, key] = third ? [second!, third] : ["anthropic", second!]
      if (!key) {
        console.error("Usage:\n  gates auth set <key>\n  gates auth set <provider> <key>")
        process.exit(1)
      }
      yield* auth.setApiKey(key, provider)
      console.log(`API key saved for "${provider}" in ~/.local/share/gates/auth.json`)
      return
    }

    if (sub === "show") {
      const keys = yield* auth.listKeys()
      const entries = Object.entries(keys)
      if (!entries.length) {
        console.log("No API keys stored.\n  Run: gates auth set <key>")
        return
      }
      console.log("\nStored API keys:")
      for (const [p, k] of entries) console.log(`  ${p.padEnd(12)} ${k}`)
      console.log()
      return
    }

    if (sub === "remove") {
      // gates auth remove             → anthropic
      // gates auth remove <provider>  → named provider
      const provider = second ?? "anthropic"
      yield* auth.removeApiKey(provider)
      console.log(`API key removed for "${provider}".`)
      return
    }

    console.log("Usage:\n  gates auth set <key>\n  gates auth set <provider> <key>\n  gates auth show\n  gates auth remove [provider]")
  }).pipe(Effect.provide(AuthLayer))
