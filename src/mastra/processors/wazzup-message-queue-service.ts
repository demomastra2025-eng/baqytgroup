import { createClient, type RedisClientType } from 'redis';

export type WazzupOutboundMessage = {
  channelId: string;
  chatType: string;
  chatId: string;
  text: string;
  refMessageId?: string;
  attempt?: number;
  timestamp?: number;
};

export type WazzupMessageQueueServiceOptions = {
  redisUrl?: string;
  queuePrefix?: string;
  maxRetries?: number;
};

type LoggerLike = {
  info?: (message?: unknown, ...meta: unknown[]) => void;
  warn?: (message?: unknown, ...meta: unknown[]) => void;
  error?: (message?: unknown, ...meta: unknown[]) => void;
  debug?: (message?: unknown, ...meta: unknown[]) => void;
};

export class WazzupMessageQueueService {
  private readonly client: RedisClientType;
  private readonly queuePrefix: string;
  private readonly maxRetries: number;
  private connectPromise?: Promise<RedisClientType>;
  private readonly logger?: LoggerLike;

  constructor({
    redisUrl = process.env.REDIS_URL,
    queuePrefix = 'mastra:wazzup-queue',
    maxRetries = 3,
    logger,
  }: WazzupMessageQueueServiceOptions & { logger?: LoggerLike } = {}) {
    if (!redisUrl) {
      throw new Error('WazzupMessageQueueService: REDIS_URL must be provided via options or env');
    }

    this.client = createClient({ url: redisUrl });
    this.client.on('error', (error) => {
      this.log('error', 'Redis error', { error });
    });
    this.queuePrefix = queuePrefix.replace(/\s+/g, '-');
    this.maxRetries = maxRetries;
    this.logger = logger;
  }

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: Record<string, unknown>) {
    const logger = this.logger?.[level];
    if (typeof logger === 'function') {
      meta ? logger.call(this.logger, meta, message) : logger.call(this.logger, message);
      return;
    }

    const fallback = console[level] ?? console.log;
    fallback(`[WazzupQueue] ${message}`, meta ?? '');
  }

  /**
   * Добавить сообщение в очередь
   */
  async enqueue(message: WazzupOutboundMessage): Promise<void> {
    await this.ensureClient();

    const payload = {
      ...message,
      attempt: (message.attempt ?? 0) + 1,
      timestamp: message.timestamp ?? Date.now(),
    };

    const queueKey = this.getQueueKey();
    await this.client.rPush(queueKey, JSON.stringify(payload));

    this.log('debug', 'Сообщение добавлено в очередь Wazzup', {
      chatId: message.chatId,
      queueLength: await this.client.lLen(queueKey),
    });
  }

  /**
   * Получить следующее сообщение из очереди (блокирующий вызов)
   */
  async dequeue(timeoutSeconds = 1): Promise<WazzupOutboundMessage | null> {
    await this.ensureClient();

    const queueKey = this.getQueueKey();
    const result = await this.client.blPop(queueKey, timeoutSeconds);

    if (!result) {
      return null;
    }

    try {
      const message = JSON.parse(result.element) as WazzupOutboundMessage;
      return message;
    } catch (error) {
      this.log('error', 'Не удалось распарсить сообщение из очереди', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Переместить сообщение в очередь повторных попыток
   */
  async retryMessage(message: WazzupOutboundMessage): Promise<boolean> {
    await this.ensureClient();

    if ((message.attempt ?? 0) >= this.maxRetries) {
      this.log('warn', 'Сообщение превышило максимум повторных попыток', {
        chatId: message.chatId,
        attempt: message.attempt,
        maxRetries: this.maxRetries,
      });

      // Перемещаем в очередь мертвых писем
      await this.client.rPush(this.getDeadLetterKey(), JSON.stringify(message));
      return false;
    }

    // Возвращаем в основную очередь — не инкрементируем здесь, enqueue
    // сам увеличивает счётчик попыток на 1, поэтому передаём текущее значение.
    await this.enqueue({
      ...message,
      attempt: message.attempt ?? 0,
    });

    this.log('debug', 'Сообщение перемещено в очередь повторных попыток', {
      chatId: message.chatId,
      attempt: message.attempt,
    });

    return true;
  }

  /**
   * Получить статистику очереди
   */
  async getStats(): Promise<{
    queueLength: number;
    deadLetterLength: number;
  }> {
    await this.ensureClient();

    const queueLength = await this.client.lLen(this.getQueueKey());
    const deadLetterLength = await this.client.lLen(this.getDeadLetterKey());

    return {
      queueLength,
      deadLetterLength,
    };
  }

  /**
   * Получить сообщения из очереди мертвых писем (для диагностики)
   */
  async getDeadLetters(count = 10): Promise<WazzupOutboundMessage[]> {
    await this.ensureClient();

    const deadLetterKey = this.getDeadLetterKey();
    const items = await this.client.lRange(deadLetterKey, 0, count - 1);

    return items
      .map((item) => {
        try {
          return JSON.parse(item) as WazzupOutboundMessage;
        } catch {
          return null;
        }
      })
      .filter((item): item is WazzupOutboundMessage => item !== null);
  }

  /**
   * Очистить очередь мертвых писем
   */
  async clearDeadLetters(): Promise<number> {
    await this.ensureClient();

    const deadLetterKey = this.getDeadLetterKey();
    return await this.client.del(deadLetterKey);
  }

  /**
   * Закрыть соединение с Redis
   */
  async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private getQueueKey(): string {
    return `${this.queuePrefix}:main`;
  }

  private getDeadLetterKey(): string {
    return `${this.queuePrefix}:dead-letters`;
  }

  private async ensureClient(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }

    this.connectPromise ??= this.client.connect();
    try {
      await this.connectPromise;
    } catch (error) {
      this.connectPromise = undefined;
      throw error;
    }
  }
}
