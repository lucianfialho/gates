import { Effect, Layer, Context } from "effect"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const authPath = join(homedir(), ".local", "share", "gates", "auth.json")

interface AuthFile {
  anthropic?: { apiKey: string }
}

const readAuthFile = (): Effect.Effect<AuthFile> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(authPath, "utf-8")
      return JSON.parse(raw) as AuthFile
    },
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
  readonly getApiKey: () => Effect.Effect<string | undefined>
  readonly setApiKey: (key: string) => Effect.Effect<void>
  readonly removeApiKey: () => Effect.Effect<void>
}

export class Auth extends Context.Service<Auth, AuthShape>()("gates/Auth") {}

const makeImpl: Effect.Effect<AuthShape> = Effect.sync(() => ({
  getApiKey: () =>
    Effect.gen(function* () {
      if (process.env["ANTHROPIC_API_KEY"]) return process.env["ANTHROPIC_API_KEY"]
      const file = yield* readAuthFile()
      return file.anthropic?.apiKey
    }),

  setApiKey: (key: string) =>
    Effect.gen(function* () {
      const file = yield* readAuthFile()
      yield* writeAuthFile({ ...file, anthropic: { apiKey: key } })
    }),

  removeApiKey: () =>
    Effect.gen(function* () {
      const file = yield* readAuthFile()
      const { anthropic: _, ...rest } = file
      yield* writeAuthFile(rest)
    }),
}))

export const AuthLayer = Layer.effect(Auth)(makeImpl)
