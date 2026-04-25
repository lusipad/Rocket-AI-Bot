import { Router } from 'express';
import type { LLMClient } from '../../llm/client.js';
import type { RocketChatClient } from '../../bot/client.js';
import type { Scheduler } from '../../scheduler/index.js';
import type { Logger } from '../../utils/logger.js';

export function createStatusRoutes(
  llm: LLMClient,
  bot: RocketChatClient,
  scheduler: Scheduler,
  logger: Logger,
): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const tasks = scheduler.listTasks();
    res.json({
      version: '1.0.0',
      uptime: process.uptime(),
      memory: {
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
      },
      connections: {
        rocketchat: bot.isConnected ? 'connected' : 'disconnected',
        llm: llm.circuitBreaker.stateName,
      },
      model: llm.getModel(),
      scheduler: {
        total: tasks.length,
        active: tasks.filter(t => t.enabled).length,
      },
    });
  });

  return router;
}
