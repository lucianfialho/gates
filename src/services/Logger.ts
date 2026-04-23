import { Context, Layer } from "effect"

export type LogLevel = "info" | "pass" | "block" | "warn" | "error"

export interface LogEntry {
  readonly timestamp: string
  readonly event: string
  readonly gate?: string
  readonly tool?: string
  readonly duration_ms?: number
  readonly message: string
}

export interface LoggerShape {
  readonly log: (
    level: LogLevel,
    message: string,
    meta?: { gate?: string; tool?: string; duration_ms?: number | undefined }
  ) => void
  readonly info: (message: string, meta?: { gate?: string; tool?: string; duration_ms?: number | undefined }) => void
  readonly pass: (gate: string, tool: string, duration_ms?: number | undefined) => void
  readonly block: (gate: string, tool: string, reason: string, duration_ms?: number | undefined) => void
  readonly warn: (message: string, meta?: { gate?: string; tool?: string; duration_ms?: number | undefined }) => void
  readonly error: (message: string, meta?: { gate?: string; tool?: string; duration_ms?: number | undefined }) => void
}

export class Logger extends Context.Service<Logger, LoggerShape>()("gates/Logger") {}

const TRUNCATE_LENGTH = 200
const TRUNCATE_SUFFIX = "..."

const truncate = (str: string): string => {
  if (str.length <= TRUNCATE_LENGTH) return str
  return str.slice(0, TRUNCATE_LENGTH - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX
}

// ASCII color codes
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  redBold: "\x1b[31;1m",
}

const colorFor = (level: LogLevel): string => {
  switch (level) {
    case "pass": return colors.green
    case "block": return colors.red
    case "warn": return colors.yellow
    case "error": return colors.redBold
    default: return colors.reset
  }
}

const labelFor = (level: LogLevel): string => {
  switch (level) {
    case "pass": return "PASS"
    case "block": return "BLOCK"
    case "warn": return "WARN"
    case "error": return "ERR"
    default: return "INFO"
  }
}

const makeImpl = (): LoggerShape => {
  const log = (
    level: LogLevel,
    message: string,
    meta?: { gate?: string; tool?: string; duration_ms?: number | undefined }
  ): void => {
    const timestamp = new Date().toISOString()
    const c = colorFor(level)
    const label = labelFor(level)

    const parts: string[] = []
    parts.push(`${colors.dim}${timestamp}${colors.reset}`)
    parts.push(`${c}[${label}]${colors.reset}`)

    const gate = meta?.gate
    const tool = meta?.tool
    const duration_ms = meta?.duration_ms
    if (gate) parts.push(`${colors.cyan}${gate}${colors.reset}`)
    if (tool) parts.push(`${colors.magenta}${tool}${colors.reset}`)
    if (duration_ms !== undefined) parts.push(`${colors.dim}(${duration_ms}ms)${colors.reset}`)

    const msg = truncate(message)
    parts.push(msg)

    console.error(parts.join(" "))

    // Also emit structured JSON for machine parsing (when not on a TTY)
    if (!process.stdout.isTTY) {
      const structured: Record<string, unknown> = {
        timestamp,
        event: level,
        gate: gate,
        tool: tool,
        duration_ms: duration_ms,
        message: msg,
      }
      if (message.length > TRUNCATE_LENGTH) {
        structured._originalLength = message.length
      }
      console.error(JSON.stringify(structured))
    }
  }

  return {
    log,
    info: (message, meta) => log("info", message, meta),
    pass: (gate, tool, duration_ms) =>
      log("pass", `${gate} → ${tool} allowed`, { gate, tool, duration_ms }),
    block: (gate, tool, reason, duration_ms) =>
      log("block", truncate(reason), { gate, tool, duration_ms }),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  }
}

export const LoggerLayer = Layer.succeed(Logger)(makeImpl())