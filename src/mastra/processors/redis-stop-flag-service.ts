import { createClient, type RedisClientType } from 'redis';

export type RedisStopFlagServiceOptions = {
  redisUrl?: string;
  keyPrefix?: string;
};

export class RedisStopFlagService {
  private readonly client: RedisClientType;
  private readonly keyPrefix: string;
  private connectPromise?: Promise<RedisClientType>;

  constructor({
    redisUrl = process.env.REDIS_URL,
    keyPrefix = 'mastra:input-stop',
  }: RedisStopFlagServiceOptions = {}) {
    if (!redisUrl) {
      throw new Error('RedisStopFlagService: REDIS_URL must be provided via options or env');
    }

    this.client = createClient({ url: redisUrl });
    this.client.on('error', (error) => {
      console.error('[RedisStopFlagService] Redis error', error);
    });
    this.keyPrefix = keyPrefix.replace(/\s+/g, '-');
  }

  async setStop(chatId: string, value = 'stop') {
    await this.ensureClient();
    await this.client.set(this.buildKey(chatId), value);
  }

  async clearStop(chatId: string) {
    await this.ensureClient();
    await this.client.del(this.buildKey(chatId));
  }

  private buildKey(chatId: string) {
    return `${this.keyPrefix}:${chatId}`;
  }

  private async ensureClient() {
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
