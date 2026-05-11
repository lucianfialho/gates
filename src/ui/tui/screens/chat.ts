import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  SyntaxStyle,
} from "@opentui/core";
import type { CliRenderer, ScrollbackSurface } from "@opentui/core";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";
import { parseSseChunk } from "../shared/sse.js";
import { COLORS } from "../shared/colors.js";

export class ChatScreen {
  // split-footer layout:
  //   scrollback surface  ← messages stream here (scrollable)
  //   footer (3 lines)    ← header + input + status

  private surface: ScrollbackSurface;
  private footer: BoxRenderable;   // lives in renderer.root (footer area)
  private input: InputRenderable;
  private statusText: TextRenderable;

  private renderer: CliRenderer;
  private sessionId: string;
  private sseBuffer = "";
  private abortController: AbortController | null = null;
  private keyHandler: (key: { name: string; ctrl: boolean }) => void;

  private syntaxStyle: SyntaxStyle;

  constructor(
    _ctx: unknown,               // ignored — use renderer directly
    renderer: CliRenderer,
    harness: LoadedHarness,
    sessionId: string,
    private onBack: () => void,
  ) {
    this.syntaxStyle = SyntaxStyle.create();
    this.renderer = renderer;
    this.sessionId = sessionId;

    // ── Scrollback surface (fills the top scroll area) ────────────────────
    this.surface = renderer.createScrollbackSurface();

    // ── Footer (3 lines): header | input | status ─────────────────────────
    this.footer = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });

    // Header row
    const header = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 1,
    });
    const headerText = new TextRenderable(renderer, {
      content: `◆ ${harness.name}  [${sessionId.slice(0, 8)}]`,
      fg: COLORS.cyan,
      flexGrow: 1,
    });
    const hint = new TextRenderable(renderer, {
      content: "Esc voltar  Ctrl+C sair",
      fg: COLORS.dim,
    });
    header.add(headerText);
    header.add(hint);
    this.footer.add(header);

    // Input row
    const inputRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 1,
    });
    const prompt = new TextRenderable(renderer, {
      content: "❯ ",
      fg: COLORS.cyan,
    });
    this.input = new InputRenderable(renderer, {
      placeholder: "Mensagem…",
      flexGrow: 1,
    });
    this.input.on(InputRenderableEvents.ENTER, () => {
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      void this.sendMessage(text);
    });
    inputRow.add(prompt);
    inputRow.add(this.input);
    this.footer.add(inputRow);

    // Status row
    const statusRow = new BoxRenderable(renderer, { height: 1, paddingLeft: 1 });
    this.statusText = new TextRenderable(renderer, { content: "ready", fg: COLORS.dim });
    statusRow.add(this.statusText);
    this.footer.add(statusRow);

    renderer.root.add(this.footer);
    this.renderer.focusRenderable(this.input);

    // ── Keys ──────────────────────────────────────────────────────────────
    this.keyHandler = (key: { name: string; ctrl: boolean }) => {
      if (key.name === "escape") {
        this.abortController?.abort();
        onBack();
      }
      if (key.ctrl && key.name === "c") renderer.destroy();
    };
    renderer.keyInput.on("keypress", this.keyHandler);
  }

  private appendMessage(role: "user" | "assistant" | "system", content: string) {
    const ctx = this.surface.renderContext;
    const row = new BoxRenderable(ctx, {
      flexDirection: "column",
      marginBottom: 1,
      paddingLeft: 1,
    });

    const label = role === "user" ? "You" : role === "assistant" ? "Agent" : "System";
    const labelColor = role === "user" ? COLORS.cyan : role === "assistant" ? COLORS.green : COLORS.yellow;

    const header = new TextRenderable(ctx, {
      content: label,
      fg: labelColor,
    });
    row.add(header);

    const body = new MarkdownRenderable(ctx, {
      content,
      syntaxStyle: this.syntaxStyle,
      flexGrow: 1,
    });
    row.add(body);

    this.surface.root.add(row);
    this.surface.commitRows(0, this.surface.height);
  }

  private async sendMessage(text: string) {
    this.appendMessage("user", text);
    this.statusText.content = "pensando…";
    this.input.value = "";

    this.abortController = new AbortController();

    // Streaming response
    const ctx = this.surface.renderContext;
    const msgRow = new BoxRenderable(ctx, { flexDirection: "column", marginBottom: 1, paddingLeft: 1 });
    const agentLabel = new TextRenderable(ctx, { content: "Agent", fg: COLORS.green });
    const md = new MarkdownRenderable(ctx, {
      streaming: true,
      syntaxStyle: this.syntaxStyle,
      flexGrow: 1,
    });
    msgRow.add(agentLabel);
    msgRow.add(md);
    this.surface.root.add(msgRow);

    let fullContent = "";

    try {
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${this.sessionId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
          signal: this.abortController.signal,
        },
      );

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          const { buffer, events } = parseSseChunk(
            this.sseBuffer,
            decoder.decode(value, { stream: true }),
          );
          this.sseBuffer = buffer;

          for (const { type, data } of events) {
            const d = data as Record<string, unknown>;
            if (type === "thinking") {
              this.statusText.content = "pensando…";
            } else if (type === "tool_call") {
              this.statusText.content = `⟳ ${d.name as string}`;
            } else if (type === "delta") {
              fullContent += (d.text as string) ?? "";
              md.content = fullContent;
              this.surface.commitRows(0, this.surface.height);
            } else if (type === "done") {
              md.content = (d.content as string) ?? fullContent;
              md.streaming = false;
              this.surface.commitRows(0, this.surface.height);
            }
          }
        }
      } finally {
        reader?.cancel().catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        md.content = `Error: ${(err as Error).message}`;
        md.streaming = false;
        this.surface.commitRows(0, this.surface.height);
      }
    }

    this.statusText.content = "ready";
    this.renderer.focusRenderable(this.input);
  }

  // root is not used in split-footer — surface + footer are separate
  get root(): BoxRenderable { return this.footer; }

  destroy(): void {
    this.abortController?.abort();
    this.renderer.keyInput.off("keypress", this.keyHandler);
    this.surface.destroy();
    this.footer.destroy();
  }
}
