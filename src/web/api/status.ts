import { Router } from 'express';
import type { LLMClient } from '../../llm/client.js';
import type { RocketChatClient } from '../../bot/client.js';
import type { Scheduler } from '../../scheduler/index.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { Logger } from '../../utils/logger.js';
import type { RequestLogStore } from '../../observability/request-log-store.js';
import type { DiscussionSummaryAdminService } from '../../discussion/admin-service.js';
import type { AgentDefinition } from '../../agent-core/definition.js';
import type { AgentRegistry } from '../../agent-core/registry.js';

export function createStatusRoutes(
  llm: LLMClient,
  bot: RocketChatClient,
  scheduler: Scheduler,
  skillRegistry: SkillRegistry,
  requestLogStore: RequestLogStore,
  discussionAdminService: DiscussionSummaryAdminService,
  agentRegistry: AgentRegistry,
  logger: Logger,
): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const tasks = scheduler.listTasks();
    const skills = skillRegistry.listInstalled();
    const agentDefinition = agentRegistry.getDefault();
    const agents = agentRegistry.list();
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
      agent: {
        id: agentDefinition.id,
        name: agentDefinition.name,
        model: agentDefinition.model,
        deepModel: agentDefinition.deepModel,
        channels: agentDefinition.channels,
        skillPolicy: agentDefinition.skillPolicy,
        contextPolicyRef: agentDefinition.contextPolicyRef,
      },
      agents: {
        total: agents.length,
        defaultId: agentDefinition.id,
        items: agents.map(toAgentStatus),
      },
      scheduler: {
        total: tasks.length,
        active: tasks.filter(t => t.enabled).length,
      },
      skills: {
        installed: skills.length,
        enabled: skills.filter((skill) => skill.enabled).length,
      },
      requests: requestLogStore.summarizeRecent(50),
      context: {
        policy: discussionAdminService.getPolicy(),
        summaries: {
          total: discussionAdminService.list(500).length,
        },
      },
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

function toAgentStatus(agent: AgentDefinition) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    deepModel: agent.deepModel,
    channels: agent.channels,
    skillPolicy: agent.skillPolicy,
    contextPolicyRef: agent.contextPolicyRef,
  };
}
