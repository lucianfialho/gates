import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";
import { parseSseChunk } from "../shared/sse.js";

// Left-only ┃ border — same visual separator as OpenCode
const LEFT_BORDER = {
  topLeft: " ", topRight: " ", bottomLeft: " ", bottomRight: " ",
  horizontal: " ", vertical: "┃", topT: " ", bottomT: " ",
  leftT: " ", rightT: " ", cross: " ",
};

export class ChatScreen {
  root: BoxRenderable;
  private renderer: CliRenderer;
  private syntaxStyle: SyntaxStyle;
  private messagesBox: ScrollBoxRenderable;
  private input: InputRenderable;
  private statusText: TextRenderable;
  private sessionId: string;
  private sseBuffer = "";
  private abortController: AbortController | null = null;
  private keyHandler: (key: { name: string; ctrl: boolean; shift: boolean }) => void;

  constructor(
    _ctx: unknown,
    renderer: CliRenderer,
    harness: LoadedHarness,
    sessionId: string,
    private onBack: () => void,
  ) {
    this.renderer = renderer;
    this.sessionId = sessionId;
    this.syntaxStyle = SyntaxStyle.create();

    // ── Root: full screen column ─────────────────────────────────────────
    // Use explicit terminal dimensions — "100%" doesn't resolve without
    // a fixed parent. Listen to resize and update accordingly.
    const W = process.stdout.columns ?? 80;
    const H = process.stdout.rows ?? 24;

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: W,
      height: H,
    });

    const onResize = () => {
      (this.root as BoxRenderable & { width: number; height: number }).width = process.stdout.columns ?? 80;
      (this.root as BoxRenderable & { width: number; height: number }).height = process.stdout.rows ?? 24;
    };
    process.stdout.on("resize", onResize);

    // ── Messages: scrollbox sticks to bottom ──────────────────────────────
    this.messagesBox = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.root.add(this.messagesBox);

    // ── Input area ────────────────────────────────────────────────────────
    const inputArea = new BoxRenderable(renderer, {
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    });

    // Input box with left ┃ accent border
    const inputBox = new BoxRenderable(renderer, {
      border: ["left"],
      customBorderChars: LEFT_BORDER,
      borderColor: "#4a9eff",
      paddingLeft: 2,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    });

    this.input = new InputRenderable(renderer, {
      placeholder: "Message gates…",
      flexGrow: 1,
    });

    this.input.on(InputRenderableEvents.ENTER, () => {
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      void this.sendMessage(text);
    });

    inputBox.add(this.input);
    inputArea.add(inputBox);

    // Status line below input
    const statusLine = new BoxRenderable(renderer, {
      height: 1,
      paddingLeft: 3,
      flexDirection: "row",
      justifyContent: "space-between",
    });

    this.statusText = new TextRenderable(renderer, {
      content: `${harness.name}`,
      fg: "#888888",
    });

    const hint = new TextRenderable(renderer, {
      content: "esc back  ctrl+c quit",
      fg: "#555555",
    });

    statusLine.add(this.statusText);
    statusLine.add(hint);
    inputArea.add(statusLine);
    this.root.add(inputArea);

    renderer.root.add(this.root);
    renderer.focusRenderable(this.input);

    // ── Keys ─────────────────────────────────────────────────────────────
    this.keyHandler = (key: { name: string; ctrl: boolean; shift: boolean }) => {
      if (key.name === "escape") { this.abortController?.abort(); onBack(); }
      if (key.ctrl && key.name === "c") renderer.destroy();
    };
    renderer.keyInput.on("keypress", this.keyHandler);
  }

  private addMessage(role: "user" | "assistant" | "system", content: string) {
    const row = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      border: role === "assistant" ? ["left"] : false,
      customBorderChars: role === "assistant" ? LEFT_BORDER : undefined,
      borderColor: role === "assistant" ? "#4a9eff" : undefined,
    });

    const label = new TextRenderable(this.renderer, {
      content: role === "user" ? "You" : role === "assistant" ? "gates" : "·",
      fg: role === "user" ? "#00d4ff" : role === "assistant" ? "#4a9eff" : "#888888",
      attributes: 1, // bold
    });
    row.add(label);

    const body = new MarkdownRenderable(this.renderer, {
      content,
      syntaxStyle: this.syntaxStyle,
      paddingTop: 1,
    });
    row.add(body);
    this.messagesBox.add(row);
  }

  private async sendMessage(text: string) {
    this.addMessage("user", text);
    this.statusText.content = "thinking…";
    this.abortController = new AbortController();

    // Add streaming assistant message
    const row = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      border: ["left"],
      customBorderChars: LEFT_BORDER,
      borderColor: "#4a9eff",
    });

    const label = new TextRenderable(this.renderer, {
      content: "gates",
      fg: "#4a9eff",
      attributes: 1,
    });

    const md = new MarkdownRenderable(this.renderer, {
      content: "",
      streaming: true,
      syntaxStyle: this.syntaxStyle,
      paddingTop: 1,
    });

    row.add(label);
    row.add(md);
    this.messagesBox.add(row);

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
              this.statusText.content = "thinking…";
            } else if (type === "tool_call") {
              this.statusText.content = `⟳ ${d.name as string}`;
            } else if (type === "tool_result") {
              this.statusText.content = "thinking…";
            } else if (type === "delta") {
              fullContent += (d.text as string) ?? "";
              md.content = fullContent;
            } else if (type === "done") {
              const finalContent = (d.content as string) ?? fullContent;
              md.content = finalContent;
              md.streaming = false;
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
      } else {
        md.streaming = false;
      }
    }

    this.statusText.content = "ready";
    this.renderer.focusRenderable(this.input);
  }

  destroy(): void {
    this.abortController?.abort();
    this.renderer.keyInput.off("keypress", this.keyHandler);
    process.stdout.removeAllListeners("resize");
    this.root.destroy();
  }
}
