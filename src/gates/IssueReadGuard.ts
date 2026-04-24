import { Effect } from "effect"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

/**
 * IssueReadGuard — prevents gh_issue_read from being called with
 * related issue numbers when the actual task is a plain text description.
 *
 * The analyze prompt says "If issue is a GitHub number, call gh_issue_read".
 * But the agent was calling gh_issue_read(4) because it saw "past#4" in
 * research context (related issues), confusing them with the actual task.
 *
 * This gate blocks gh_issue_read if:
 *   1. The original issue (GATES_ORIGINAL_ISSUE env var) is NOT a pure number
 *   2. OR the call's number doesn't match the original issue number
 *
 * Result: agent can only call gh_issue_read if the user actually gave
 * a GitHub issue number as the task. Plain text tasks get blocked.
 */
export const issueReadGuardGate: Gate = {
  name: "issue-read-guard",
  matches: (call: ToolCall) => call.name === "gh_issue_read",
  check: (call: ToolCall) => {
    const originalIssue = process.env["GATES_ORIGINAL_ISSUE"] ?? ""
    const isIssueNum = /^\d+$/.test(originalIssue.trim())

    if (!isIssueNum) {
      return block(
        "issue-read-guard",
        `gh_issue_read blocked — the task "${originalIssue.slice(0, 80)}" is not a GitHub issue number.\n` +
        `Do NOT call gh_issue_read on related issues found in research context (past#N).\n` +
        `Proceed directly to producing the PRP JSON based on the research output.`
      )
    }

    // Task IS a number — allow, but only for the original issue number
    const callNum = String((call.input as Record<string, unknown>)["number"] ?? "")
    if (callNum !== originalIssue.trim()) {
      return block(
        "issue-read-guard",
        `gh_issue_read blocked — called with #${callNum} but task is issue #${originalIssue.trim()}.\n` +
        `Only call gh_issue_read for the original task issue, not related issues (past#N).`
      )
    }

    return pass
  },
}
