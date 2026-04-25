import path from 'node:path';
import http from 'node:http';
import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { ensureDir } from './utils/helpers.js';
import { RocketChatClient } from './bot/client.js';
import { MessageDeduplicator } from './bot/deduplicator.js';
import { MessageRouter } from './bot/message-handler.js';
import { LLMClient } from './llm/client.js';
import { Orchestrator, splitMessage } from './agent/orchestrator.js';
import { RateLimiter } from './agent/rate-limiter.js';
import { ToolRegistry } from './tools/registry.js';
import { createRepoSearchTool } from './tools/repo-search.js';
import { createReadFileTool } from './tools/read-file.js';
import { createCodexTool } from './tools/codex.js';
import { createAzureDevOpsTool } from './tools/azure-devops.js';
import { createRoomHistoryTool } from './tools/room-history.js';
import { TaskPersistence, type TaskDef } from './scheduler/persistence.js';
import { Scheduler } from './scheduler/index.js';
import { createWebServer } from './web/server.js';
import type { BotMessage } from './bot/message-handler.js';

const DEFAULT_DISCUSSION_CONTEXT_COUNT = 40;
const EXTENDED_DISCUSSION_CONTEXT_COUNT = 80;
const EXTENDED_DISCUSSION_PATTERN = /(总结|汇总|回顾|梳理|归纳|结论|分歧|待办|继续|上面|刚才|前面)/;

async function main() {
  const config = loadConfig();
  const logger = createLogger(path.resolve('data/logs'));

  ensureDir('data/logs');
  ensureDir('data/memory');
  ensureDir('data/scheduler');
  ensureDir('data/scheduler/history');

  logger.info('RocketBot 启动中...', { version: '1.0.0', node: process.version });

  // --- 工具注册 ---
  const registry = new ToolRegistry(logger);

  if (config.repos.length > 0) {
    registry.register(createRepoSearchTool(config.repos));
    registry.register(createReadFileTool(config.repos));
  }

  if (config.codex.path) {
    registry.register(
      createCodexTool(config.codex.path, config.codex.workingDir ?? process.cwd(), config.codex.maxConcurrency),
    );
    logger.info('Codex 工具已注册', { path: config.codex.path });
  }

  if (config.azureDevOps?.serverUrl && config.azureDevOps?.pat) {
    registry.register(
      createAzureDevOpsTool({
        serverUrl: config.azureDevOps.serverUrl,
        pat: config.azureDevOps.pat,
        project: config.azureDevOps.project ?? 'DefaultCollection',
      }),
    );
    logger.info('Azure DevOps 工具已注册');
  }

  // --- Rocket.Chat ---
  const deduplicator = new MessageDeduplicator(1000, 'data/memory');
  const bot = new RocketChatClient(config, logger);
  const router = new MessageRouter(bot, deduplicator, config, logger);
  const limiter = new RateLimiter(
    config.rateLimit.channelCooldownMs,
    config.rateLimit.userMaxPerMinute,
  );
  registry.register(createRoomHistoryTool(bot));

  // --- LLM + Orchestrator ---
  const llm = new LLMClient(config, logger);
  const orchestrator = new Orchestrator(llm, registry, config, logger);

  router.on('mention', async (msg: BotMessage) => {
    const channelWait = limiter.checkChannel(msg.roomId);
    if (channelWait > 0) {
      await bot.sendToRoomId('正在处理上一条请求，请稍等...', msg.roomId);
      return;
    }
    if (limiter.checkUser(msg.userId)) {
      await bot.sendToRoomId(
        `@${msg.username} 请稍后，每分钟只能提问 ${config.rateLimit.userMaxPerMinute} 次`,
        msg.roomId,
      );
      return;
    }
    limiter.touch(msg.roomId, msg.userId);

    logger.info('收到消息触发', {
      trigger: msg.roomType === 'd' ? 'dm' : 'mention',
      username: msg.username,
      room: msg.roomName || msg.roomId,
      text: msg.text.slice(0, 100),
    });

    try {
      bot.sendToRoomId('正在思考...', msg.roomId).catch(() => {});

      const contextCount = shouldUseExtendedDiscussionContext(msg.text)
        ? EXTENDED_DISCUSSION_CONTEXT_COUNT
        : DEFAULT_DISCUSSION_CONTEXT_COUNT;
      const recentMessages = await bot.getRecentMessages(
        msg.roomId,
        msg.roomType,
        {
          count: contextCount,
          excludeMessageId: msg.id,
          currentTimestamp: msg.timestamp,
          threadId: msg.threadId,
        },
      );
      const currentImages = await bot.resolveImageUrls(msg.images.map((image) => image.url));
      const reply = await orchestrator.handle(
        msg.userId,
        msg.username,
        msg.text,
        recentMessages,
        currentImages,
        {
          roomId: msg.roomId,
          roomType: msg.roomType,
          threadId: msg.threadId,
          triggerMessageId: msg.id,
          timestamp: msg.timestamp,
        },
      );
      const parts = splitMessage(reply);
      for (const part of parts) {
        await bot.sendToRoomId(part, msg.roomId);
      }
    } catch (err) {
      logger.error('处理失败', { error: String(err) });
      await bot.sendToRoomId('抱歉，出了点问题，请重试。', msg.roomId);
    }
  });

  await bot.connect();
  await bot.syncAvailability(llm.circuitBreaker.stateName);

  const presenceTimer = setInterval(() => {
    bot.syncAvailability(llm.circuitBreaker.stateName).catch((err) => {
      logger.warn('同步机器人状态失败', { error: String(err) });
    });
  }, 10000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bot as any)['callback'] = (err: Error | null, message: any, meta: any) =>
    router.handleRawMessage(err, message, meta);

  // --- 调度系统 ---
  const persistence = new TaskPersistence(config.scheduler.persistencePath);
  const scheduler = new Scheduler(persistence, async (task: TaskDef) => {
    // 定时任务执行器：可以通过 LLM 处理
    try {
      const instruction = task.prompt?.trim() || task.name;
      const reply = await orchestrator.handle('scheduler', '系统', `执行定时任务: ${instruction}`, []);
      await bot.sendToRoomId(reply, task.room);
      return { success: true, output: reply.slice(0, 500) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, logger);

  // 注册预配置的任务
  for (const task of config.scheduler.tasks) {
    if (task.enabled) {
      scheduler.addTask(task);
    }
  }
  scheduler.start();

  // --- Web 服务 ---
  const app = createWebServer({
    logger,
    scheduler,
    llm,
    bot,
    webSecret: config.web.secret,
  });

  const webPort = config.web.port;
  const server = http.createServer(app);
  server.listen(webPort, () => {
    logger.info(`Web 管理服务: http://localhost:${webPort}/admin`);
  });

  // --- 优雅关闭 ---
  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，开始优雅关闭...`);
    clearInterval(presenceTimer);
    scheduler.stopAll();
    deduplicator.flush();
    server.close();
    await bot.disconnect();
    logger.info('已关闭');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

function shouldUseExtendedDiscussionContext(text: string): boolean {
  return EXTENDED_DISCUSSION_PATTERN.test(text);
}
