import express from 'express';
import path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { Scheduler } from '../scheduler/index.js';
import type { LLMClient } from '../llm/client.js';
import type { RocketChatClient } from '../bot/client.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { RequestLogStore } from '../observability/request-log-store.js';
import type { DiscussionSummaryAdminService } from '../discussion/admin-service.js';
import type { AgentDefinition } from '../agent-core/definition.js';
import { createTaskRoutes } from './api/tasks.js';
import { createStatusRoutes } from './api/status.js';
import { createSkillRoutes } from './api/skills.js';
import { createRequestRoutes } from './api/requests.js';
import { createContextRoutes } from './api/context.js';

const ADMIN_ROUTE_ALIASES = ['/', '/tasks', '/skills', '/context', '/requests', '/logs', '/config'];

export interface WebContext {
  logger: Logger;
  scheduler: Scheduler;
  llm: LLMClient;
  bot: RocketChatClient;
  skillRegistry: SkillRegistry;
  requestLogStore: RequestLogStore;
  discussionAdminService: DiscussionSummaryAdminService;
  agentDefinition: AgentDefinition;
  webSecret?: string;
}

export function createWebServer(ctx: WebContext): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());

  // CORS
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    next();
  });

  // 健康检查（无鉴权）
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: {
        rocketchat: ctx.bot.isConnected ? 'connected' : 'disconnected',
        llm: ctx.llm.circuitBreaker.stateName,
      },
    });
  });

  // 简单鉴权
  if (ctx.webSecret) {
    app.use('/api', (req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token === ctx.webSecret) return next();
      res.status(401).json({ error: 'Unauthorized' });
    });
  }

  // API 路由
  app.use('/api/tasks', createTaskRoutes(ctx.scheduler, ctx.logger));
  app.use('/api/status', createStatusRoutes(
    ctx.llm,
    ctx.bot,
    ctx.scheduler,
    ctx.skillRegistry,
    ctx.requestLogStore,
    ctx.discussionAdminService,
    ctx.agentDefinition,
    ctx.logger,
  ));
  app.use('/api/skills', createSkillRoutes(ctx.skillRegistry, ctx.logger));
  app.use('/api/requests', createRequestRoutes(ctx.requestLogStore, ctx.logger));
  app.use('/api/context', createContextRoutes(ctx.discussionAdminService, ctx.logger));

  // 静态文件：React SPA
  const adminDir = path.resolve('src/web/admin');
  for (const route of ADMIN_ROUTE_ALIASES) {
    app.get(route, (_req, res) => {
      const target = route === '/' ? '/admin' : `/admin${route}`;
      res.redirect(302, target);
    });
  }
  app.use('/admin', express.static(adminDir));
  app.get('/admin/*', (_req, res) => {
    res.sendFile(path.join(adminDir, 'index.html'));
  });

  ctx.logger.info('Web 服务已就绪');
  return app;
}
