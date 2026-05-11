import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
} from "@opentui/core";
import type { CliRenderer, RenderContext } from "@opentui/core";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";
import { parseSseChunk } from "../shared/sse.js";
import { COLORS } from "../shared/colors.js";

export class ChatScreen {
  root: BoxRenderable;
  private renderer: CliRenderer;
  private ctx: RenderContext;
  private keyHandler: (key: { name: string; ctrl: boolean }) => void;

  private messagesBox: ScrollBoxRenderable;
  private streamingText: TextRenderable;
  private toolText: TextRenderable;
  private statusText: TextRenderable;
  private input: InputRenderable;

  private sessionId: string;
  private syntaxStyle: SyntaxStyle;
  private streamingContent = "";
  private sseBuffer = "";
  private abortController: AbortController | null = null;
  private isStreaming = false;

  constructor(
    ctx: RenderContext,
    renderer: CliRenderer,
    harness: LoadedHarness,
    sessionId: string,
    onBack: () => void,
  ) {
    this.ctx = ctx;
    this.renderer = renderer;
    this.sessionId = sessionId;
    this.syntaxStyle = SyntaxStyle.create();

    this.root = new BoxRenderable(ctx, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });

    // ── Header ────────────────────────────────────────────────────────────────
    const header = new BoxRenderable(ctx, {
      height: 1,
      border: ["bottom"],
      borderColor: COLORS.cyan,
    });
    const headerText = new TextRenderable(ctx, {
      content: `◆ gates  ${harness.name}  [${sessionId.slice(0, 8)}]`,
      fg: COLORS.cyan,
    });
    header.add(headerText);
    this.root.add(header);

    // ── Body ──────────────────────────────────────────────────────────────────
    const body = new BoxRenderable(ctx, {
      flexDirection: "column",
      flexGrow: 1,
    });

    this.messagesBox = new ScrollBoxRenderable(ctx, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
    });
    body.add(this.messagesBox);

    this.streamingText = new TextRenderable(ctx, {
      content: "",
      fg: COLORS.white,
    });
    body.add(this.streamingText);

    const toolBox = new BoxRenderable(ctx, { height: 1 });
    this.toolText = new TextRenderable(ctx, { content: "", fg: COLORS.yellow });
    toolBox.add(this.toolText);
    body.add(toolBox);

    this.root.add(body);

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = new BoxRenderable(ctx, {
      flexDirection: "column",
      height: 3,
      border: ["top"],
      borderColor: COLORS.dim,
    });

    this.statusText = new TextRenderable(ctx, {
      content: "ready",
      fg: COLORS.gray,
    });
    footer.add(this.statusText);

    this.input = new InputRenderable(ctx, {
      placeholder: "Type a message…",
      flexGrow: 1,
    });
    footer.add(this.input);

    this.root.add(footer);

    renderer.focusRenderable(this.input);

    this.input.on(InputRenderableEvents.ENTER, () => {
      const text = this.input.value.trim();
      if (!text || this.isStreaming) return;
      this.input.value = "";
      void this.sendMessage(text);
    });

    this.keyHandler = (key: { name: string; ctrl: boolean }) => {
      if (key.name === "escape") {
        if (this.abortController) {
          this.abortController.abort();
        } else {
          onBack();
        }
        return;
      }
      // Ctrl+K reserved for kanban
    };
    renderer.keyInput.on("keypress", this.keyHandler);
  }

  private addMessage(role: "user" | "assistant" | "system", content: string): void {
    const msgBox = new BoxRenderable(this.ctx, {
      flexDirection: "column",
      paddingX: 1,
    });

    const roleLabel = new TextRenderable(this.ctx, {
      content: role === "user" ? "you" : role === "assistant" ? "assistant" : "system",
      fg: role === "user" ? COLORS.green : role === "assistant" ? COLORS.cyan : COLORS.yellow,
    });

    const body = new MarkdownRenderable(this.ctx, {
      content,
      syntaxStyle: this.syntaxStyle,
      streaming: false,
      fg: COLORS.white,
    });

    msgBox.add(roleLabel);
    msgBox.add(body);
    this.messagesBox.add(msgBox);
  }

  private handleSseEvent(type: string, d: Record<string, unknown>): void {
    switch (type) {
      case "thinking":
        this.statusText.content = "pensando…";
        break;
      case "tool_call":
        this.statusText.content = "chamando ferramentas…";
        this.toolText.content = `⚙ ${d.name as string}`;
        break;
      case "tool_result":
        this.toolText.content = "";
        break;
      case "delta":
        this.statusText.content = "streaming…";
        this.streamingContent += (d.text as string) ?? "";
        this.streamingText.content = this.streamingContent;
        break;
      case "done":
        this.addMessage("assistant", d.content as string);
        this.streamingContent = "";
        this.streamingText.content = "";
        this.toolText.content = "";
        this.statusText.content = "ready";
        break;
      case "error":
        this.addMessage("system", `Error: ${d.message as string}`);
        this.streamingContent = "";
        this.streamingText.content = "";
        this.toolText.content = "";
        this.statusText.content = "error";
        setTimeout(() => {
          this.statusText.content = "ready";
        }, 2000);
        break;
    }
  }

  private async sendMessage(text: string): Promise<void> {
    this.isStreaming = true;
    this.streamingContent = "";
    this.sseBuffer = "";
    this.statusText.content = "pensando…";
    this.addMessage("user", text);

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${this.sessionId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
          signal: controller.signal,
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
            this.handleSseEvent(type, data as Record<string, unknown>);
          }
        }
      } finally {
        // Always release the stream lock — prevents resource leak on abort or error
        reader?.cancel().catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.addMessage("system", `Error: ${(err as Error).message}`);
        this.statusText.content = "error";
        setTimeout(() => {
          this.statusText.content = "ready";
        }, 2000);
      } else {
        this.statusText.content = "ready";
      }
      this.streamingContent = "";
      this.streamingText.content = "";
      this.toolText.content = "";
    } finally {
      this.isStreaming = false;
      this.abortController = null;
    }
  }

  destroy(): void {
    this.renderer.keyInput.off("keypress", this.keyHandler);
    if (this.abortController) {
      this.abortController.abort();
    }
    this.root.destroy();
  }
}
