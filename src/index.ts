#!/usr/bin/env bun
/**
 * gates — CLI entry point
 * Routes sub-commands to the appropriate handler.
 */
import { Effect, Context } from "effect"
import { routeCommand } from "./cli/args.js"
import { startChatTUI } from "./commands/chat.js"

// ─── Main ───────────────────────────────────────────────────────────────────────

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

async function main() {
  await routeCommand()
}