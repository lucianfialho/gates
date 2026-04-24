import { Layer } from "effect"
import { readFile } from "node:fs/promises"
import { LLMLayer } from "../services/LLM.js"
import { GateRegistryLayer } from "../services/GateRegistry.js"
import { ToolRegistryLayer } from "../services/Tools.js"
import { BuiltinGatesLayer } from "../gates/builtin.js"
import { PersistenceLayer } from "../machine/Persistence.js"
import { GatewayServiceLive } from "../machine/Gateway.js"
import { startChat } from "../chat/index.js"

const buildAppLayer = () => Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer)),
  GatewayServiceLive.pipe(Layer.provide(LLMLayer))
)

export const startChatTUI = async (): Promise<void> => {
  const AppLayer = buildAppLayer()
  let systemPrompt: string | undefined
  try {
    const claude = await readFile("CLAUDE.md", "utf-8")
    systemPrompt = `You are an autonomous coding agent. Here is the project context:\n\n${claude}\n\nCurrent working directory: ${process.cwd()}`
  } catch { /* no CLAUDE.md */ }
  await startChat(AppLayer as never, systemPrompt)
}
