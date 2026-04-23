import { Effect, Layer, Context } from "effect"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const authPath = join(homedir(), ".local", "share", "gates", "auth.json")

export type ProviderName = "anthropic" | "openai" | "minimax" | string

interface ProviderAuth {
  apiKey: string
}

type AuthFile = Partial<Record<ProviderName, ProviderAuth>>

const readAuthFile = (): Effect.Effect<AuthFile> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(authPath, "utf-8")) as AuthFile,
    catch: () => ({} as AuthFile),
  }).pipe(Effect.orElseSucceed(() => ({} as AuthFile)))

const writeAuthFile = (data: AuthFile): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(join(homedir(), ".local", "share", "gates"), { recursive: true })
      await writeFile(authPath, JSON.stringify(data, null, 2), { mode: 0o600 })
    },
    catch: (e) => new Error(String(e)),
  }).pipe(Effect.orDie)

export interface AuthShape {
  readonly getApiKey: (provider?: ProviderName) => Effect.Effect<string | undefined>
  readonly setApiKey: (key: string, provider?: ProviderName) => Effect.Effect<void>
  readonly removeApiKey: (provider?: ProviderName) => Effect.Effect<void>
  readonly listKeys: () => Effect.Effect<Record<string, string>>
}

export class Auth extends Context.Service<Auth, AuthShape>()("gates/Auth") {}

// env var precedence per provider
const envKeyFor = (provider: ProviderName): string | undefined => {
  if (provider === "anthropic") return process.env["ANTHROPIC_API_KEY"]
  if (provider === "openai")    return process.env["OPENAI_API_KEY"]
  return process.env["GATES_API_KEY"]
}

const makeImpl: Effect.Effect<AuthShape> = Effect.sync(() => ({
  getApiKey: (provider: ProviderName = "anthropic") =>
    Effect.gen(function* () {
      const fromEnv = envKeyFor(provider)
      if (fromEnv) return fromEnv
      const file = yield* readAuthFile()
      return file[provider]?.apiKey
    }),

  setApiKey: (key: string, provider: ProviderName = "anthropic") =>
    Effect.gen(function* () {
      const file = yield* readAuthFile()
      yield* writeAuthFile({ ...file, [provider]: { apiKey: key } })
    }),

  removeApiKey: (provider: ProviderName = "anthropic") =>
    Effect.gen(function* () {
      const file = yield* readAuthFile()
      const updated = { ...file }
      delete updated[provider]
      yield* writeAuthFile(updated)
    }),

  listKeys: () =>
    Effect.gen(function* () {
      const file = yield* readAuthFile()
      const result: Record<string, string> = {}
      for (const [p, v] of Object.entries(file)) {
        if (v?.apiKey) {
          const k = v.apiKey
          result[p] = `${k.slice(0, 10)}...${k.slice(-4)}`
        }
      }
      return result
    }),
}))

export const AuthLayer = Layer.effect(Auth)(makeImpl)
