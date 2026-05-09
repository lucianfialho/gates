import { Effect } from "effect";
import { listSessions, makeFileSessionStore } from "@gatesai/runtime";

interface SessionsOptions {
  all?: boolean;
}

const doSessions = (options: SessionsOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sessions = yield* listSessions();

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    const formatSessionId = (s: string) => s.startsWith("chat:") ? s.slice(5) : s;

    console.log(`Found ${sessions.length} session(s):\n`);
    for (const sessionId of sessions.sort()) {
      console.log(`  - ${formatSessionId(sessionId)}`);
    }

    if (options.all) {
      console.log("\nDetailed info:");
      for (const sessionId of sessions.sort()) {
        const store = yield* makeFileSessionStore();
        const data = yield* store.load(sessionId);
        if (data) {
          const msgCount = data.entries.filter((e) => e.type === "message").length;
          console.log(`  ${formatSessionId(sessionId)}: ${msgCount} messages, updated ${data.updatedAt}`);
        }
      }
    }
  });

export const sessions = (options: SessionsOptions): void => {
  Effect.runPromise(doSessions(options));
};