import type { WazzupOutboundMessage } from './wazzup-message-queue-service';
import { WazzupMessageQueueService } from './wazzup-message-queue-service';

const WAZZUP_MESSAGE_URL = process.env.WAZZUP_MESSAGE_API_URL ?? 'https://api.wazzup24.com/v3/message';
const WAZZUP_API_TOKEN = process.env.WAZZUP_API_TOKEN;
const WAZZUP_SEND_TIMEOUT_MS = parseInt(process.env.WAZZUP_SEND_TIMEOUT_MS ?? '30000', 10);

type LoggerLike = {
  info?: (message?: unknown, ...meta: unknown[]) => void;
  warn?: (message?: unknown, ...meta: unknown[]) => void;
  error?: (message?: unknown, ...meta: unknown[]) => void;
  debug?: (message?: unknown, ...meta: unknown[]) => void;
};

export type WazzupQueueWorkerOptions = {
  logger?: LoggerLike;
  pollIntervalMs?: number;
  pollTimeoutSeconds?: number;
  enabled?: boolean;
};

export class WazzupQueueWorker {
  private queueService: WazzupMessageQueueService;
  private logger?: LoggerLike;
  private pollIntervalMs: number;
  private pollTimeoutSeconds: number;
  private isRunning = false;
  private processingPromise?: Promise<void>;

  constructor(options: WazzupQueueWorkerOptions = {}) {
    this.queueService = new WazzupMessageQueueService({ logger: options.logger });
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000; // Проверяем очередь каждые 5 сек
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 1;

    if (options.enabled !== false) {
      this.start();
    }
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, unknown>) {
    const logger = this.logger?.[level];
    if (typeof logger === 'function') {
      meta ? logger.call(this.logger, meta, message) : logger.call(this.logger, message);
      return;
    }

    const fallback = console[level] ?? console.log;
    fallback(`[WazzupQueueWorker] ${message}`, meta ?? '');
  }

  /**
   * Запустить обработку очереди в фоне
   */
  start(): void {
    if (this.isRunning) {
      this.log('warn', 'WazzupQueueWorker уже запущен');
      return;
    }

    this.isRunning = true;
    this.log('info', 'WazzupQueueWorker запущен');

    // Запускаем обработку в фоне (не ждем)
    this.processingPromise = this.processQueue();
  }

  /**
   * Остановить обработку очереди
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.log('info', 'Остановка WazzupQueueWorker...');

    if (this.processingPromise) {
      await this.processingPromise;
    }

    await this.queueService.disconnect();
    this.log('info', 'WazzupQueueWorker остановлен');
  }

  /**
   * Основной цикл обработки очереди
   */
  private async processQueue(): Promise<void> {
    while (this.isRunning) {
      try {
        const message = await this.queueService.dequeue(this.pollTimeoutSeconds);

        if (!message) {
          // Очередь пуста, делаем небольшую паузу перед следующей проверкой
          continue;
        }

        await this.processMessage(message);
      } catch (error) {
        this.log('error', 'Ошибка при обработке очереди', {
          error: error instanceof Error ? error.stack ?? error.message : error,
        });
        // Небольшая пауза перед повторной попыткой при ошибке
        await this.sleep(1000);
      }
    }
  }

  /**
   * Обработать одно сообщение
   */
  private async processMessage(message: WazzupOutboundMessage): Promise<void> {
    try {
      this.log('info', 'Обработка сообщения из очереди', {
        chatId: message.chatId,
        attempt: message.attempt,
      });

      const success = await this.sendToWazzup(message);

      if (success) {
        this.log('info', 'Сообщение успешно отправлено в Wazzup', {
          chatId: message.chatId,
          messageId: message.refMessageId,
        });
        return;
      }

      // Если отправка не удалась, попытаемся повторить
      const shouldRetry = await this.queueService.retryMessage(message);
      if (shouldRetry) {
        this.log('warn', 'Сообщение отправлено на повторную попытку', {
          chatId: message.chatId,
          attempt: message.attempt,
        });
      } else {
        this.log('error', 'Сообщение перемещено в очередь мертвых писем', {
          chatId: message.chatId,
          attempt: message.attempt,
        });
      }
    } catch (error) {
      this.log('error', 'Ошибка при обработке сообщения', {
        error: error instanceof Error ? error.stack ?? error.message : error,
        chatId: message.chatId,
      });

      // Пытаемся повторить
      await this.queueService.retryMessage(message);
    }
  }

  /**
   * Отправить сообщение в Wazzup API
   */
  private async sendToWazzup(message: WazzupOutboundMessage): Promise<boolean> {
    if (!WAZZUP_API_TOKEN) {
      this.log('warn', 'WAZZUP_API_TOKEN is not configured; cannot send message');
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WAZZUP_SEND_TIMEOUT_MS);

    try {
      const response = await fetch(WAZZUP_MESSAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WAZZUP_API_TOKEN}`,
        },
        body: JSON.stringify({
          channelId: message.channelId,
          chatType: message.chatType,
          chatId: message.chatId,
          text: message.text,
          refMessageId: message.refMessageId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response
          .clone()
          .json()
          .catch(async () => response.text().catch(() => undefined));

        this.log('error', 'Wazzup API вернул ошибку', {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
        });
        return false;
      }

      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.log('error', 'Таймаут при отправке в Wazzup', {
          timeoutMs: WAZZUP_SEND_TIMEOUT_MS,
          chatId: message.chatId,
        });
        return false;
      }

      this.log('error', 'Ошибка при отправке в Wazzup', {
        error: error instanceof Error ? error.stack ?? error.message : error,
        chatId: message.chatId,
      });
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Получить статистику очереди
   */
  async getStats(): Promise<{
    isRunning: boolean;
    queueLength: number;
    deadLetterLength: number;
  }> {
    const stats = await this.queueService.getStats();
    return {
      isRunning: this.isRunning,
      ...stats,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Глобальный экземпляр воркера (для использования в маршрутах)
let globalWorker: WazzupQueueWorker | null = null;

export const getWazzupQueueWorker = (): WazzupQueueWorker => {
  if (!globalWorker) {
    globalWorker = new WazzupQueueWorker({ enabled: process.env.WAZZUP_QUEUE_ENABLED !== 'false' });
  }
  return globalWorker;
};

export const stopWazzupQueueWorker = async (): Promise<void> => {
  if (globalWorker) {
    await globalWorker.stop();
    globalWorker = null;
  }
};
