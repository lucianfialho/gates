import { Effect } from "effect"

export class GateError {
  readonly _tag = "GateError"
  constructor(
    readonly gate: string,
    readonly reason: string
  ) {}
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface Gate {
  readonly name: string
  readonly matches: (call: ToolCall) => boolean
  readonly check: (call: ToolCall) => Effect.Effect<void, GateError>
}
