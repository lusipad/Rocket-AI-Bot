import { Router } from 'express';
import type { LLMClient } from '../../llm/client.js';
import type { RocketChatClient } from '../../bot/client.js';
import type { Scheduler } from '../../scheduler/index.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { Logger } from '../../utils/logger.js';
import type { RequestLogStore } from '../../observability/request-log-store.js';

export function createStatusRoutes(
  llm: LLMClient,
  bot: RocketChatClient,
  scheduler: Scheduler,
  skillRegistry: SkillRegistry,
  requestLogStore: RequestLogStore,
  logger: Logger,
): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const tasks = scheduler.listTasks();
    const skills = skillRegistry.listInstalled();
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
      deepModel: llm.getDeepModel(),
      apiMode: llm.getApiMode(),
      scheduler: {
        total: tasks.length,
        active: tasks.filter(t => t.enabled).length,
      },
      skills: {
        installed: skills.length,
        enabled: skills.filter((skill) => skill.enabled).length,
      },
      requests: requestLogStore.summarizeRecent(50),
    });
  });

  router.post('/llm-api-mode-probe', async (_req, res) => {
    try {
      const result = await llm.probeApiModes();
      logger.info('LLM API 模式探测完成', {
        current: result.current,
        recommended: result.recommended,
      });
      res.json(result);
    } catch (error) {
      logger.error('LLM API 模式探测失败', { error: String(error) });
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
