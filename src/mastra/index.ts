
import 'dotenv/config';

import { LogLevel } from '@mastra/core/logger';
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import {
  CloudExporter,
  DefaultExporter,
  SensitiveDataFilter,
  SamplingStrategyType,
} from '@mastra/core/ai-tracing';
import { baqytAgent } from './agents/baqyt-agent';
import { scorers as baqytScorers } from './scorers/baqyt-scorer';
import { postgresStore } from './storage/postgres';
import { wazzupWebhookRoute } from './server/routes/wazzup-webhook';
import { macroCrmMcpServer } from './mcp/macrocrm-server';
import { getWazzupQueueWorker, stopWazzupQueueWorker } from './processors/wazzup-queue-worker';

type MastraLogLevel = (typeof LogLevel)[keyof typeof LogLevel];
const LOG_LEVELS = new Set<MastraLogLevel>(Object.values(LogLevel) as MastraLogLevel[]);

const resolveLogLevel = (): MastraLogLevel => {
  const rawLevel = process.env.LOG_LEVEL?.toLowerCase() as MastraLogLevel | undefined;
  if (rawLevel && LOG_LEVELS.has(rawLevel)) {
    return rawLevel;
  }

  return process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO;
};

export const mastra = new Mastra({
  agents: { baqytAgent },
  scorers: baqytScorers,
  storage: postgresStore,
  mcpServers: {
    macroCRM: macroCrmMcpServer,
  },
  server: {
    build: {
      swaggerUI: true,
      openAPIDocs: true,
    },
    apiRoutes: [wazzupWebhookRoute],
  },
  logger: new PinoLogger({
    name: 'Mastra',
    level: resolveLogLevel(),
  }),
  telemetry: {
    enabled: false,
  },
  observability: {
    default: { enabled: false },
    configs: {
      default: {
        serviceName: 'baqyt-agent',
        sampling: { type: SamplingStrategyType.ALWAYS },
        runtimeContextKeys: ['userId', 'threadId', 'customerRequest'],
        processors: [new SensitiveDataFilter()],
        exporters: [new DefaultExporter(), new CloudExporter()],
      },
    },
  },
});

// Инициализируем Wazzup очередь если включена
if (process.env.USE_WAZZUP_QUEUE === 'true') {
  try {
    getWazzupQueueWorker();
    console.log('[Mastra] Wazzup message queue worker initialized');
  } catch (error) {
    console.warn('[Mastra] Failed to initialize Wazzup queue worker', error);
  }
}

// Обработка graceful shutdown
if (typeof process !== 'undefined') {
  const shutdown = async (signal: string) => {
    console.log(`[Mastra] Received ${signal}, shutting down gracefully...`);
    await stopWazzupQueueWorker();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
