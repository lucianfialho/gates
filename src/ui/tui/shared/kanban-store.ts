import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type CardStatus = "todo" | "in-progress" | "done";

export interface KanbanCard {
  id: string;
  title: string;
  body: string;
  file: string | null;
  line: number | null;
  snippet: string | null;
  severity: "high" | "medium" | "low";
  labels: string[];
  status: CardStatus;
  chatSessionId?: string;
}

const KANBAN_STATE_PATH = path.join(os.homedir(), ".gates", "kanban-state.json");

function ensureDir(): void {
  const dir = path.dirname(KANBAN_STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const kanbanStore = {
  cards: [] as KanbanCard[],

  load(): void {
    try {
      ensureDir();
      if (fs.existsSync(KANBAN_STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(KANBAN_STATE_PATH, "utf-8")) as {
          cards?: KanbanCard[];
        };
        kanbanStore.cards = data.cards ?? [];
      }
    } catch {
      kanbanStore.cards = [];
    }
  },

  save(): void {
    try {
      ensureDir();
      fs.writeFileSync(KANBAN_STATE_PATH, JSON.stringify({ cards: kanbanStore.cards }, null, 2), "utf-8");
    } catch {
      // ignore write errors
    }
  },

  addCard(card: KanbanCard): void {
    kanbanStore.cards.push(card);
    kanbanStore.save();
  },

  updateStatus(id: string, status: CardStatus): void {
    const card = kanbanStore.cards.find(c => c.id === id);
    if (card) {
      card.status = status;
      kanbanStore.save();
    }
  },

  setSessionId(id: string, sessionId: string): void {
    const card = kanbanStore.cards.find(c => c.id === id);
    if (card) {
      card.chatSessionId = sessionId;
      kanbanStore.save();
    }
  },

  byStatus(status: CardStatus): KanbanCard[] {
    return kanbanStore.cards.filter(c => c.status === status);
  },
};
