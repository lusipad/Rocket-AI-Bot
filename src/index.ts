import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { ensureDir } from './utils/helpers.js';
import { acquireProcessLock } from './utils/process-lock.js';
import { RocketChatClient } from './bot/client.js';
import { MessageDeduplicator } from './bot/deduplicator.js';
import { MessageRouter } from './bot/message-handler.js';
import { LLMClient } from './llm/client.js';
import {
  Orchestrator,
  type ModelModePreview,
} from './agent/orchestrator.js';
import { AgentRuntime, ProjectSkillCatalog, SkillRuntime, toRequestContext } from './agent-runtime/index.js';
import { AgentRegistry } from './agent-core/registry.js';
import { createPublicRealtimeWebSearchCapability } from './agent-core/capabilities/public-realtime-web-search.js';
import { createAzureDevOpsFileUrlCapability } from './agent-core/capabilities/azure-devops-file-url.js';
import type { AgentConversationMessage, AgentResponse, AgentTrace } from './agent-core/types.js';
import { toRocketChatAgentRequest, toSchedulerAgentRequest } from './adapters/rocketchat/message-normalizer.js';
import { renderRocketChatReply } from './adapters/rocketchat/reply-renderer.js';
import { RateLimiter } from './agent/rate-limiter.js';
import { SkillRegistry } from './skills/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { createRepoSearchTool } from './tools/repo-search.js';
import { createReadFileTool } from './tools/read-file.js';
import { createCodexTool } from './tools/codex.js';
import { createAzureDevOpsTool } from './tools/azure-devops.js';
import { createAzureDevOpsServerRestTool } from './tools/azure-devops-server-rest.js';
import { createRoomHistoryTool } from './tools/room-history.js';
import { TaskPersistence, type TaskDef } from './scheduler/persistence.js';
import { Scheduler } from './scheduler/index.js';
import { createWebServer } from './web/server.js';
import { RequestLogStore, type RequestLogContext } from './observability/request-log-store.js';
import {
  ContextPolicyStore,
  resolveContextScope,
  resolvePublicChannelLookbackMs,
  resolveRecentMessageLimit,
} from './context/policy-store.js';
import { DiscussionSummaryService, isDiscussionContextRequest } from './discussion/summary-service.js';
import { DiscussionSummaryAdminService } from './discussion/admin-service.js';
import { DiscussionSummaryStore } from './discussion/summary-store.js';
import type { BotMessage } from './bot/message-handler.js';

const THINKING_MESSAGE = '正在思考...';
const DEEP_THINKING_MESSAGE = '正在深度思考...';
const THINKING_MESSAGE_DELAY_MS = 1200;
const HELP_COMMAND_PATTERN = /(^|\s)(?:\/|\|)help(?:$|\s|[，,。.!！])/i;
const STATUS_COMMAND_PATTERN = /(^|\s)(?:\/|\|)status(?:$|\s|[，,。.!！])/i;
const CONTEXT_INFO_COMMAND_PATTERN = /(^|\s)(?:\/|\|)context(?:$|\s|[，,。.!！])/i;
const CONTEXT_RESET_COMMAND_PATTERN = /(^|\s)(?:\/|\|)(?:context|上下文)\s+(?:reset|clear|重置|清空)(?:$|\s|[，,。.!！])|(^|\s)(?:\/|\|)(?:reset-context|clear-context)(?:$|\s|[，,。.!！])/i;
const ORCHESTRATOR_CONTROL_COMMAND_PATTERN = /(^|\s)(?:\/|\|)(?:skills|normal|shallow|deep(?:\s+(?:off|exit|stop|关闭|退出))?)[，,。.!！\s]*$/i;

async function main() {
  const config = loadConfig();
  const logger = createLogger(path.resolve('data/logs'));
  const lockPath = path.resolve('data/rocketbot.lock');

  ensureDir('data');
  ensureDir('data/logs');
  ensureDir('data/memory');
  ensureDir('data/scheduler');
  ensureDir('data/scheduler/history');
  ensureDir('data/agents');

  const processLock = acquireProcessLock(lockPath);
  if (!processLock.acquired) {
    logger.warn('检测到 RocketBot 已在运行，当前实例退出', {
      lockPath,
      holderPid: processLock.holderPid,
    });
    process.exit(0);
  }
  process.on('exit', () => {
    processLock.release();
  });

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

  const azureDevOpsServerCollectionUrl =
    config.azureDevOpsServer?.collectionUrl
    || config.azureDevOps?.serverUrl;
  const azureDevOpsServerPat =
    config.azureDevOpsServer?.pat
    || config.azureDevOps?.pat;
  const azureDevOpsServerScriptPath = path.resolve(
    config.azureDevOpsServer?.scriptPath
    ?? path.join('.agents', 'skills', 'azure-devops-server', 'scripts', 'Invoke-AzureDevOpsServerApi.ps1'),
  );
  if (azureDevOpsServerCollectionUrl && fs.existsSync(azureDevOpsServerScriptPath)) {
    registry.register(
      createAzureDevOpsServerRestTool({
        collectionUrl: azureDevOpsServerCollectionUrl,
        authMode: config.azureDevOpsServer?.authMode ?? (azureDevOpsServerPat ? 'pat' : 'default-credentials'),
        pat: azureDevOpsServerPat,
        project: config.azureDevOpsServer?.project ?? config.azureDevOps?.project,
        team: config.azureDevOpsServer?.team,
        apiVersion: config.azureDevOpsServer?.apiVersion,
        serverVersionHint: config.azureDevOpsServer?.serverVersionHint,
        searchBaseUrl: config.azureDevOpsServer?.searchBaseUrl,
        testResultsBaseUrl: config.azureDevOpsServer?.testResultsBaseUrl,
        scriptPath: azureDevOpsServerScriptPath,
        powerShellPath: config.azureDevOpsServer?.powerShellPath,
      }),
    );
    logger.info('Azure DevOps Server REST 工具已注册', { scriptPath: azureDevOpsServerScriptPath });
  }

  // --- Rocket.Chat ---
  const deduplicator = new MessageDeduplicator(1000, 'data/memory');
  const bot = new RocketChatClient(config, logger);
  const router = new MessageRouter(bot, deduplicator, config, logger);
  const limiter = new RateLimiter(
    config.rateLimit.channelCooldownMs,
    config.rateLimit.userMaxPerMinute,
  );
  const contextPolicyStore = new ContextPolicyStore();
  registry.register(createRoomHistoryTool(bot, contextPolicyStore));

  // --- LLM + Orchestrator ---
  const llm = new LLMClient(config, logger);
  const agentRegistry = new AgentRegistry({
    defaultModel: llm.getModel(),
    defaultDeepModel: llm.getDeepModel(),
  });
  const agentDefinition = agentRegistry.resolveForChannel('rocketchat');
  const skillRegistry = new SkillRegistry(undefined, logger);
  const orchestrator = new Orchestrator(llm, registry, config, logger, skillRegistry);
  const skillRuntime = new SkillRuntime(new ProjectSkillCatalog(skillRegistry));
  const agentRuntime = new AgentRuntime(orchestrator, llm, [
    createAzureDevOpsFileUrlCapability({
      config,
      llm,
      registry,
      resolveModelMode: (request) => orchestrator.previewModelMode(
        request.actor.id,
        request.input,
        toRequestContext(request),
      ),
      resolveRequestContext: toRequestContext,
    }),
    createPublicRealtimeWebSearchCapability({
      config,
      llm,
      resolveModelMode: (request) => orchestrator.previewModelMode(
        request.actor.id,
        request.input,
        toRequestContext(request),
      ),
    }),
  ], { skillRuntime, agentDefinition });
  const requestLogStore = new RequestLogStore();
  const discussionSummaryStore = new DiscussionSummaryStore();
  const discussionSummaryService = new DiscussionSummaryService(discussionSummaryStore);
  const discussionSummaryAdminService = new DiscussionSummaryAdminService(
    discussionSummaryStore,
    contextPolicyStore,
    bot,
    llm,
    logger,
  );

  router.on('mention', async (msg: BotMessage) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const initialAgentRequest = toRocketChatAgentRequest(msg, requestId);
    const initialModelMode = agentRuntime.previewModelMode(initialAgentRequest);

    logger.info('收到消息触发', {
      trigger: msg.roomType === 'd' ? 'dm' : 'mention',
      username: msg.username,
      room: msg.roomName || msg.roomId,
      text: msg.text.slice(0, 100),
    });

    const controlCommandReply = await handleControlCommand(
      msg,
      requestId,
      agentRuntime,
      llm,
      contextPolicyStore,
      discussionSummaryService,
    );
    if (controlCommandReply) {
      await bot.sendToRoomId(controlCommandReply.reply, msg.roomId);
      requestLogStore.record({
        requestId,
        kind: 'chat',
        status: 'success',
        finishReason: controlCommandReply.finishReason,
        model: controlCommandReply.model ?? initialModelMode.model,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        userId: msg.userId,
        username: msg.username,
        roomId: msg.roomId,
        roomType: msg.roomType,
        threadId: msg.threadId,
        triggerMessageId: msg.id,
        prompt: msg.text,
        reply: controlCommandReply.reply,
        agentId: agentDefinition.id,
        agentName: agentDefinition.name,
        requestType: 'command',
        sources: [],
        activeSkills: controlCommandReply.trace?.activeSkills ?? [],
        skillSources: controlCommandReply.trace?.skillSources ?? {},
        usedTools: controlCommandReply.trace?.usedTools ?? [],
        rounds: controlCommandReply.trace?.rounds ?? 0,
        context: buildControlCommandContext(
          msg,
          controlCommandReply.modelMode ?? initialModelMode,
          config.llm.nativeWebSearch?.enabled === true,
        ),
      });
      return;
    }

    const channelWait = limiter.checkChannel(msg.roomId);
    if (channelWait > 0) {
      await bot.sendToRoomId('正在处理上一条请求，请稍等...', msg.roomId);
      requestLogStore.record({
        requestId,
        kind: 'chat',
        status: 'rejected',
        finishReason: 'channel_cooldown',
        model: llm.getModel(),
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        userId: msg.userId,
        username: msg.username,
        roomId: msg.roomId,
        roomType: msg.roomType,
        threadId: msg.threadId,
        triggerMessageId: msg.id,
        prompt: msg.text,
        reply: '正在处理上一条请求，请稍等...',
        error: '频道冷却中',
        agentId: agentDefinition.id,
        agentName: agentDefinition.name,
        requestType: 'general',
        sources: [],
        activeSkills: [],
        skillSources: {},
        usedTools: [],
        rounds: 0,
      });
      return;
    }
    if (limiter.checkUser(msg.userId)) {
      const reply = `@${msg.username} 请稍后，每分钟只能提问 ${config.rateLimit.userMaxPerMinute} 次`;
      await bot.sendToRoomId(reply, msg.roomId);
      requestLogStore.record({
        requestId,
        kind: 'chat',
        status: 'rejected',
        finishReason: 'user_rate_limited',
        model: llm.getModel(),
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        userId: msg.userId,
        username: msg.username,
        roomId: msg.roomId,
        roomType: msg.roomType,
        threadId: msg.threadId,
        triggerMessageId: msg.id,
        prompt: msg.text,
        reply,
        error: '用户限流',
        agentId: agentDefinition.id,
        agentName: agentDefinition.name,
        requestType: 'general',
        sources: [],
        activeSkills: [],
        skillSources: {},
        usedTools: [],
        rounds: 0,
      });
      return;
    }
    limiter.touch(msg.roomId, msg.userId);

    let requestFinished = false;
    let thinkingTask: Promise<string | null> | null = null;
    let contextScope = resolveContextScope({
      roomType: msg.roomType,
      threadId: msg.threadId,
    });
    let isDiscussionRequest = false;
    let contextCount = 0;
    let recentMessages: AgentConversationMessage[] = [];
    let currentImages: string[] = [];
    let recentImageCount = 0;
    let summaryEnabled = false;
    let contextSummary: AgentConversationMessage | null = null;
    let publicChannelLookbackMs: number | undefined;
    let agentResponse: AgentResponse | undefined;
    const thinkingTimer = setTimeout(() => {
      if (requestFinished) {
        return;
      }

      thinkingTask = bot.postToRoomId(
        initialModelMode.mode === 'deep' ? DEEP_THINKING_MESSAGE : THINKING_MESSAGE,
        msg.roomId,
      );
    }, THINKING_MESSAGE_DELAY_MS);

    try {
      isDiscussionRequest = isDiscussionContextRequest(msg.text);
      const contextPolicy = contextPolicyStore.get();
      contextCount = resolveRecentMessageLimit(contextPolicy, contextScope, isDiscussionRequest);
      publicChannelLookbackMs = resolvePublicChannelLookbackMs(
        contextPolicy,
        msg.roomType,
        isDiscussionRequest,
      );
      recentMessages = await bot.getRecentMessages(
        msg.roomId,
        msg.roomType,
        {
          count: contextCount,
          excludeMessageId: msg.id,
          currentTimestamp: msg.timestamp,
          threadId: msg.threadId,
          maxLookbackMs: publicChannelLookbackMs,
        },
      );
      const scopePolicy = contextPolicy[contextScope];
      summaryEnabled = scopePolicy.summaryEnabled;
      contextSummary = scopePolicy.summaryEnabled
        ? discussionSummaryService.prepareContext(msg.text, {
          roomId: msg.roomId,
          threadId: msg.threadId,
          roomType: msg.roomType,
        })
        : null;
      const contextMessages: AgentConversationMessage[] = contextSummary
        ? [...recentMessages, contextSummary]
        : recentMessages;
      currentImages = await bot.resolveImageUrls(msg.images.map((image) => image.url));
      recentImageCount = recentMessages.reduce((sum, item) => sum + (item.images?.length ?? 0), 0);
      agentResponse = await agentRuntime.handle(
        toRocketChatAgentRequest(msg, requestId, contextMessages, currentImages),
      );
      const reply = agentResponse.text;
      const displayReply = isDiscussionRequest
        ? prependDiscussionContext(
          reply,
          Boolean(contextSummary),
          recentMessages.length,
          msg.threadId,
        )
        : reply;
      if (scopePolicy.summaryEnabled) {
        discussionSummaryService.maybeRefreshFromReply(
          msg.text,
          {
            roomId: msg.roomId,
            threadId: msg.threadId,
            roomType: msg.roomType,
          },
          contextMessages,
          displayReply,
        );
      }
      requestFinished = true;
      clearTimeout(thinkingTimer);

      const parts = renderRocketChatReply({ ...agentResponse, text: displayReply });
      if (parts.length === 0) {
        return;
      }

      const thinkingMessageId = thinkingTask ? await thinkingTask : null;
      const [firstPart, ...remainingParts] = parts;
      if (thinkingMessageId) {
        const updated = await bot.updateRoomMessage(msg.roomId, thinkingMessageId, firstPart);
        if (!updated) {
          await bot.sendToRoomId(firstPart, msg.roomId);
        }
      } else {
        await bot.sendToRoomId(firstPart, msg.roomId);
      }

      for (const part of remainingParts) {
        await bot.sendToRoomId(part, msg.roomId);
      }

      requestLogStore.record({
        requestId,
        kind: 'chat',
        status: agentResponse.trace.status,
        finishReason: agentResponse.trace.finishReason,
        model: agentResponse.model,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        userId: msg.userId,
        username: msg.username,
        roomId: msg.roomId,
        roomType: msg.roomType,
        threadId: msg.threadId,
        triggerMessageId: msg.id,
        prompt: msg.text,
        reply: displayReply,
        error: agentResponse.trace.error,
        agentId: agentResponse.agent?.id ?? agentDefinition.id,
        agentName: agentResponse.agent?.name ?? agentDefinition.name,
        requestType: agentResponse.requestType,
        sources: agentResponse.sources,
        activeSkills: agentResponse.trace.activeSkills,
        skillSources: agentResponse.trace.skillSources,
        usedTools: agentResponse.trace.usedTools,
        rounds: agentResponse.trace.rounds,
        context: {
          scope: contextScope,
          discussionRequest: isDiscussionRequest,
          recentMessageCount: recentMessages.length,
          recentMessageLimit: contextCount,
          summaryEnabled,
          summaryInjected: Boolean(contextSummary),
          summaryScope: contextSummary ? (msg.threadId ? 'thread' : 'room') : undefined,
          currentImageCount: currentImages.length,
          recentImageCount,
          nativeWebSearchEnabled: config.llm.nativeWebSearch?.enabled === true,
          webSearchUsed: agentResponse.trace.webSearchUsed === true,
          modelMode: agentResponse.trace.modelMode,
          publicChannelLookbackMinutes: publicChannelLookbackMs
            ? Math.round(publicChannelLookbackMs / 60_000)
            : undefined,
        },
      });
    } catch (err) {
      requestFinished = true;
      clearTimeout(thinkingTimer);
      logger.error('处理失败', { error: String(err) });
      const errorMessage = '抱歉，出了点问题，请重试。';
      const thinkingMessageId = thinkingTask ? await thinkingTask : null;
      if (thinkingMessageId) {
        const updated = await bot.updateRoomMessage(msg.roomId, thinkingMessageId, errorMessage);
        if (!updated) {
          await bot.sendToRoomId(errorMessage, msg.roomId);
        }
      } else {
        await bot.sendToRoomId(errorMessage, msg.roomId);
      }

      requestLogStore.record({
        requestId,
        kind: 'chat',
        status: 'error',
        finishReason: 'handler_exception',
        model: agentResponse?.model ?? initialModelMode.model,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        userId: msg.userId,
        username: msg.username,
        roomId: msg.roomId,
        roomType: msg.roomType,
        threadId: msg.threadId,
        triggerMessageId: msg.id,
        prompt: msg.text,
        reply: errorMessage,
        error: String(err),
        agentId: agentResponse?.agent?.id ?? agentDefinition.id,
        agentName: agentResponse?.agent?.name ?? agentDefinition.name,
        requestType: agentResponse?.requestType ?? 'general',
        sources: agentResponse?.sources ?? [],
        activeSkills: agentResponse?.trace.activeSkills ?? [],
        skillSources: agentResponse?.trace.skillSources ?? {},
        usedTools: agentResponse?.trace.usedTools ?? [],
        rounds: agentResponse?.trace.rounds ?? 0,
        context: {
          scope: contextScope,
          discussionRequest: isDiscussionRequest,
          recentMessageCount: recentMessages.length,
          recentMessageLimit: contextCount,
          summaryEnabled,
          summaryInjected: Boolean(contextSummary),
          summaryScope: contextSummary ? (msg.threadId ? 'thread' : 'room') : undefined,
          currentImageCount: currentImages.length,
          recentImageCount,
          nativeWebSearchEnabled: config.llm.nativeWebSearch?.enabled === true,
          webSearchUsed: agentResponse?.trace.webSearchUsed === true,
          modelMode: agentResponse?.trace.modelMode ?? initialModelMode.mode,
          publicChannelLookbackMinutes: publicChannelLookbackMs
            ? Math.round(publicChannelLookbackMs / 60_000)
            : undefined,
        },
      });
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
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    let agentResponse: AgentResponse | undefined;
    try {
      const instruction = task.prompt?.trim() || task.name;
      agentResponse = await agentRuntime.handle(
        toSchedulerAgentRequest(requestId, instruction, task.room),
      );
      const reply = agentResponse.text;
      await bot.sendToRoomId(reply, task.room);
      requestLogStore.record({
        requestId,
        kind: 'scheduler',
        status: agentResponse.trace.status,
        finishReason: agentResponse.trace.finishReason,
        model: agentResponse.model,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        username: '系统',
        roomId: task.room,
        taskName: task.name,
        taskTemplateId: task.templateId,
        prompt: instruction,
        reply,
        error: agentResponse.trace.error,
        agentId: agentResponse.agent?.id ?? agentDefinition.id,
        agentName: agentResponse.agent?.name ?? agentDefinition.name,
        requestType: agentResponse.requestType,
        sources: agentResponse.sources,
        activeSkills: agentResponse.trace.activeSkills,
        skillSources: agentResponse.trace.skillSources,
        usedTools: agentResponse.trace.usedTools,
        rounds: agentResponse.trace.rounds,
      });
      return agentResponse.trace.status === 'success'
        ? {
          success: true,
          output: reply.slice(0, 500),
          requestId,
          requestType: agentResponse.requestType,
          model: agentResponse.model,
          usedTools: agentResponse.trace.usedTools,
          sources: agentResponse.sources,
        }
        : {
          success: false,
          output: reply.slice(0, 500),
          error: agentResponse.trace.error ?? agentResponse.trace.finishReason,
          requestId,
          requestType: agentResponse.requestType,
          model: agentResponse.model,
          usedTools: agentResponse.trace.usedTools,
          sources: agentResponse.sources,
        };
    } catch (err) {
      requestLogStore.record({
        requestId,
        kind: 'scheduler',
        status: 'error',
        finishReason: 'scheduler_exception',
        model: agentResponse?.model ?? llm.getModel(),
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        username: '系统',
        roomId: task.room,
        taskName: task.name,
        taskTemplateId: task.templateId,
        prompt: task.prompt?.trim() || task.name,
        error: String(err),
        agentId: agentResponse?.agent?.id ?? agentDefinition.id,
        agentName: agentResponse?.agent?.name ?? agentDefinition.name,
        requestType: agentResponse?.requestType ?? 'scheduler',
        sources: agentResponse?.sources ?? [],
        activeSkills: agentResponse?.trace.activeSkills ?? [],
        skillSources: agentResponse?.trace.skillSources ?? {},
        usedTools: agentResponse?.trace.usedTools ?? [],
        rounds: agentResponse?.trace.rounds ?? 0,
      });
      return {
        success: false,
        error: String(err),
        requestId,
        requestType: agentResponse?.requestType,
        model: agentResponse?.model ?? llm.getModel(),
        usedTools: agentResponse?.trace.usedTools ?? [],
        sources: agentResponse?.sources ?? [],
      };
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
    skillRegistry,
    requestLogStore,
    discussionAdminService: discussionSummaryAdminService,
    agentRegistry,
    webSecret: config.web.secret,
  });

  const webPort = config.web.port;
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      logger.info(`Web 管理服务: http://localhost:${webPort}/admin`);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(webPort);
  });

  // --- 优雅关闭 ---
  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，开始优雅关闭...`);
    clearInterval(presenceTimer);
    scheduler.stopAll();
    deduplicator.flush();
    try {
      server.close();
      await bot.disconnect();
    } catch (err) {
      logger.warn('关闭过程中出现异常', { error: String(err) });
    } finally {
      processLock.release();
    }
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

async function handleControlCommand(
  msg: BotMessage,
  requestId: string,
  agentRuntime: AgentRuntime,
  llm: LLMClient,
  contextPolicyStore: ContextPolicyStore,
  discussionSummaryService: DiscussionSummaryService,
): Promise<{ reply: string; finishReason: string; model?: string; modelMode?: ModelModePreview; trace?: AgentTrace } | null> {
  if (HELP_COMMAND_PATTERN.test(msg.text)) {
    return {
      finishReason: 'command_help',
      reply: [
        '可用指令：',
        '- `|help`：查看指令列表',
        '- `|status`：查看模型、深度模式和服务状态',
        '- `|deep`：进入深度模式，30 分钟后自动退出',
        '- `|normal`：退出深度模式',
        '- `|context`：查看当前上下文策略',
        '- `|context reset`：清除当前房间/thread 的缓存摘要',
        '- `|skills`：查看已启用 skills',
        '',
        '说明：为了兼容 Rocket.Chat，推荐使用 `|` 前缀；`/` 前缀仍保留为兼容别名。',
      ].join('\n'),
    };
  }

  if (STATUS_COMMAND_PATTERN.test(msg.text)) {
    const modelMode = agentRuntime.previewModelMode({
      ...toRocketChatAgentRequest(msg, requestId),
      input: '',
    });
    const scope = resolveContextScope({
      roomType: msg.roomType,
      threadId: msg.threadId,
    });
    return {
      finishReason: 'command_status',
      model: modelMode.model,
      modelMode,
      reply: [
        '当前状态：',
        `- 模式：${modelMode.mode === 'deep' ? '深度模式' : '普通模式'}`,
        `- 深度模式：${modelMode.mode === 'deep' ? '已开启' : '未开启'}`,
        `- 当前模型：${modelMode.model}`,
        `- 默认模型：${llm.getModel()}`,
        `- 深度模型：${llm.getDeepModel() ?? '未配置'}`,
        `- 自动退出：${formatDeepModeRemaining(modelMode)}`,
        '- 退出指令：`|normal` 或 `|deep off`',
        `- API 模式：${llm.getApiMode()}`,
        `- LLM 熔断器：${llm.circuitBreaker.stateName}`,
        `- 当前范围：${formatContextScope(scope)}`,
      ].join('\n'),
    };
  }

  if (CONTEXT_RESET_COMMAND_PATTERN.test(msg.text)) {
    const deleted = discussionSummaryService.clear({
      roomId: msg.roomId,
      threadId: msg.threadId,
      roomType: msg.roomType,
    });
    const target = msg.threadId ? '当前 thread' : '当前房间';
    const summaryStatus = deleted ? '已清除缓存摘要' : '没有找到缓存摘要';

    return {
      finishReason: 'context_reset',
      reply: `${target}${summaryStatus}。我仍会读取最近聊天消息；如果要减少可见历史，需要在管理页调整上下文策略。`,
    };
  }

  if (ORCHESTRATOR_CONTROL_COMMAND_PATTERN.test(msg.text)) {
    const response = await agentRuntime.handle(
      toRocketChatAgentRequest(msg, requestId),
    );

    return {
      reply: response.text,
      trace: response.trace,
      finishReason: response.trace.finishReason ?? 'command',
      model: response.model,
      modelMode: response.trace.modelMode
        ? { mode: response.trace.modelMode, model: response.model }
        : undefined,
    };
  }

  if (!CONTEXT_INFO_COMMAND_PATTERN.test(msg.text)) {
    return null;
  }

  const scope = resolveContextScope({
    roomType: msg.roomType,
    threadId: msg.threadId,
  });
  const policy = contextPolicyStore.get();
  const scopePolicy = policy[scope];
  const summary = discussionSummaryService.get({
    roomId: msg.roomId,
    threadId: msg.threadId,
    roomType: msg.roomType,
  });

  return {
    finishReason: 'command_context',
    reply: [
      '当前上下文：',
      `- 范围：${scope === 'thread' ? 'thread' : scope === 'direct' ? '私聊' : '房间'}`,
      `- 默认读取最近消息：${scopePolicy.recentMessageCount} 条`,
      `- 讨论型请求读取：${scopePolicy.discussionRecentMessageCount} 条`,
      `- 缓存摘要：${scopePolicy.summaryEnabled ? '启用' : '关闭'}`,
      `- 当前缓存摘要：${summary ? `有，更新于 ${summary.updatedAt}` : '无'}`,
      scope === 'group'
        ? `- 公开频道回看窗口：${policy.publicChannel.discussionLookbackMinutes} 分钟`
        : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n'),
  };
}

function prependDiscussionContext(
  reply: string,
  hasSummary: boolean,
  recentMessageCount: number,
  threadId?: string,
): string {
  const contextLine = hasSummary
    ? `上下文: ${threadId ? '当前 thread' : '当前房间'} 讨论摘要 + 最近 ${recentMessageCount} 条消息`
    : `上下文: 最近 ${recentMessageCount} 条消息`;
  return `${contextLine}\n\n${reply}`;
}

function buildControlCommandContext(
  msg: BotMessage,
  modelMode: ModelModePreview,
  nativeWebSearchEnabled: boolean,
): RequestLogContext {
  return {
    scope: resolveContextScope({
      roomType: msg.roomType,
      threadId: msg.threadId,
    }),
    discussionRequest: false,
    recentMessageCount: 0,
    recentMessageLimit: 0,
    summaryEnabled: false,
    summaryInjected: false,
    currentImageCount: 0,
    recentImageCount: 0,
    nativeWebSearchEnabled,
    webSearchUsed: false,
    modelMode: modelMode.mode,
  };
}

function formatDeepModeRemaining(modelMode: ModelModePreview): string {
  if (modelMode.mode !== 'deep') {
    return '未开启';
  }

  if (modelMode.remainingMs === undefined) {
    return '本次请求结束后自动退出';
  }

  const minutes = Math.max(1, Math.ceil(modelMode.remainingMs / 60_000));
  return `约 ${minutes} 分钟后`;
}

function formatContextScope(scope: ReturnType<typeof resolveContextScope>): string {
  switch (scope) {
    case 'thread':
      return 'thread';
    case 'direct':
      return '私聊';
    case 'group':
      return '房间';
  }
}
