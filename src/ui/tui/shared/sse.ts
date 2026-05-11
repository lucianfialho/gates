export type SseEventType =
  | 'message'
  | 'open'
  | 'error'
  | 'close';

export interface SseEvent {
  type: SseEventType;
  data?: string;
  lastEventId?: string;
}

export type SseHandler = (event: SseEvent) => void;

export interface SseConnection {
  url: string;
  eventSource: EventSource | null;
  handlers: Partial<Record<SseEventType, SseHandler>>;
  reconnectDelay: number;
  maxRetries: number;
  retryCount: number;
}

export interface SseConfig {
  url: string;
  onMessage?: SseHandler;
  onOpen?: SseHandler;
  onError?: SseHandler;
  onClose?: SseHandler;
  reconnectDelay?: number;
  maxRetries?: number;
}

export function createSseConnection(config: SseConfig): SseConnection {
  return {
    url: config.url,
    eventSource: null,
    handlers: {
      message: config.onMessage,
      open: config.onOpen,
      error: config.onError,
      close: config.onClose,
    },
    reconnectDelay: config.reconnectDelay ?? 1000,
    maxRetries: config.maxRetries ?? 5,
    retryCount: 0,
  };
}

export function connectSse(connection: SseConnection): void {
  if (typeof EventSource === 'undefined') {
    connection.handlers.error?.({ type: 'error', data: 'EventSource not available' });
    return;
  }

  const eventSource = new EventSource(connection.url);
  connection.eventSource = eventSource;

  eventSource.onmessage = (event: MessageEvent) => {
    connection.handlers.message?.({
      type: 'message',
      data: event.data,
      lastEventId: event.lastEventId,
    });
  };

  eventSource.onopen = () => {
    connection.retryCount = 0;
    connection.handlers.open?.({ type: 'open' });
  };

  eventSource.onerror = () => {
    connection.handlers.error?.({ type: 'error' });

    if (connection.retryCount < connection.maxRetries) {
      connection.retryCount++;
      setTimeout(() => reconnectSse(connection), connection.reconnectDelay);
    } else {
      connection.handlers.close?.({ type: 'close' });
    }
  };
}

export function reconnectSse(connection: SseConnection): void {
  disconnectSse(connection);
  connectSse(connection);
}

export function disconnectSse(connection: SseConnection): void {
  connection.eventSource?.close();
  connection.eventSource = null;
}