import type { Config } from '../../config/schema.js';
import type { ChatOptions, LLMClient } from '../../llm/client.js';
import { getCompletionMetadata } from '../../llm/client.js';
import type { AgentCapability } from '../capabilities.js';
import type { AgentRequest, AgentResponse } from '../types.js';

type ModelMode = { mode: 'normal' | 'deep'; model: string };

export interface PublicRealtimeWebSearchCapabilityOptions {
  config: Config;
  llm: LLMClient;
  resolveModelMode?: (request: AgentRequest) => ModelMode;
}

export function createPublicRealtimeWebSearchCapability(
  options: PublicRealtimeWebSearchCapabilityOptions,
): AgentCapability {
  return {
    id: 'public-realtime-web-search',
    description: 'Fast path for public realtime internet/news queries using native web search.',
    priority: 100,
    canHandle: (request) => shouldUsePublicRealtimeWebSearch(request.input, options.config),
    handle: async (request) => handlePublicRealtimeWebSearch(request, options),
  };
}

function shouldUsePublicRealtimeWebSearch(message: string, config: Config): boolean {
  if (config.llm.nativeWebSearch?.enabled !== true) {
    return false;
  }

  const normalized = message
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || PRIVATE_CONTEXT_PATTERN.test(normalized)) {
    return false;
  }
  if (ORCHESTRATOR_COMMAND_PATTERN.test(normalized) || EXPLICIT_SKILL_PATTERN.test(normalized)) {
    return false;
  }

  return EXPLICIT_TIME_WINDOW_PATTERN.test(normalized)
    || (FRESHNESS_WORD_PATTERN.test(normalized) && PUBLIC_INFO_TOPIC_PATTERN.test(normalized));
}

async function handlePublicRealtimeWebSearch(
  request: AgentRequest,
  options: PublicRealtimeWebSearchCapabilityOptions,
): Promise<AgentResponse> {
  const modelMode = options.resolveModelMode?.(request)
    ?? { mode: 'normal', model: options.llm.getModel() };

  try {
    const response = await options.llm.chat([
      {
        role: 'system',
        content: buildPublicRealtimeSystemPrompt(options.config, modelMode),
      },
      {
        role: 'user',
        content: request.input,
      },
    ], [], buildChatOptions(modelMode, 'responses'));
    const responseMeta = getCompletionMetadata(response);
    const reply = response.choices[0]?.message?.content?.trim() ?? '';

    if (!reply || isWebSearchUnavailableReply(reply)) {
      return buildAgentResponse({
        request,
        modelMode,
        status: 'error',
        text: '这次请求需要实时联网，但上游模型没有返回可用的联网搜索结果。当前已启用 native web search；请稍后重试，或在后台切换到确认支持 Responses web_search 的模型/API。',
        finishReason: 'web_search_unavailable',
        error: reply || 'empty web search reply',
        webSearchUsed: responseMeta.webSearchUsed,
      });
    }

    return buildAgentResponse({
      request,
      modelMode,
      status: 'success',
      text: reply,
      finishReason: 'web_search_fast_path',
      webSearchUsed: true,
    });
  } catch (error) {
    return buildAgentResponse({
      request,
      modelMode,
      status: 'error',
      text: `联网搜索请求失败：${summarizeRuntimeError(error)}。当前已启用 native web search，但 provider 搜索接口本次没有成功返回；请稍后重试，或在后台切换到确认支持 Responses web_search 的模型/API。`,
      finishReason: 'web_search_error',
      error: String(error),
      webSearchUsed: false,
    });
  }
}

function buildAgentResponse(input: {
  request: AgentRequest;
  modelMode: ModelMode;
  status: 'success' | 'error';
  text: string;
  finishReason: string;
  error?: string;
  webSearchUsed: boolean;
}): AgentResponse {
  return {
    requestId: input.request.id,
    status: input.status,
    text: input.text,
    messages: [{ type: 'text', text: input.text }],
    finishReason: input.finishReason,
    error: input.error,
    model: input.modelMode.model,
    modelMode: input.modelMode.mode,
    trace: {
      activeSkills: [],
      skillSources: {},
      usedTools: [],
      rounds: 1,
      status: input.status,
      finishReason: input.finishReason,
      error: input.error,
      webSearchUsed: input.webSearchUsed,
      modelUsed: input.modelMode.mode === 'deep' ? input.modelMode.model : undefined,
      modelMode: input.modelMode.mode,
    },
  };
}

function buildChatOptions(
  modelMode: ModelMode,
  apiMode?: Config['llm']['apiMode'],
): ChatOptions | undefined {
  const options: ChatOptions = {};
  if (modelMode.mode === 'deep') {
    options.model = modelMode.model;
  }
  if (apiMode) {
    options.apiMode = apiMode;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function buildPublicRealtimeSystemPrompt(config: Config, modelMode: ModelMode): string {
  const deepStatus = modelMode.mode === 'deep'
    ? `\n- 当前使用深度模式，模型为 ${modelMode.model}。`
    : '';

  return `你是 RocketBot，运行在 Rocket.Chat 中，使用中文简洁回答。
本次请求是公开互联网实时信息查询。你必须使用模型原生联网搜索能力获取最新信息，再给出结论。
如果搜索失败或超时，明确说“联网搜索失败/超时”，不要声称系统没有联网工具，也不要编造新闻。
回答尽量包含来源标题或原始链接，控制在 700 字以内。${deepStatus}
当前默认模型：${config.llm.model ?? 'unknown'}`;
}

function isWebSearchUnavailableReply(reply: string): boolean {
  return WEB_UNAVAILABLE_REPLY_PATTERN.test(reply);
}

function summarizeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout|Request timed out/i.test(message)) {
    return '上游搜索接口超时';
  }
  if (/502|upstream request failed|bad gateway/i.test(message)) {
    return '上游搜索接口返回 502';
  }
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

const EXPLICIT_TIME_WINDOW_PATTERN = /(?:24\s*小时|过去\s*\d+\s*(?:小时|天|日)|近\s*\d+\s*(?:小时|天|日)|今天|今日|昨天|本周|本月)/i;
const FRESHNESS_WORD_PATTERN = /(?:最新|最近|实时|刚刚)/i;
const PUBLIC_INFO_TOPIC_PATTERN = /(?:新闻|资讯|热点|动态|消息|公告|发布|价格|行情|版本|更新|模型|model|release)/i;
const PRIVATE_CONTEXT_PATTERN = /(?:本地|仓库|代码|文件|分支|提交|commit|diff|review|PR|pull\s*request|工单|work\s*item|pipeline|构建|build|CI|测试|报错|日志|Azure\s*DevOps|ADO|TFS|Rocket\.?Chat|群里|刚才|上面|上下文)/i;
const WEB_UNAVAILABLE_REPLY_PATTERN = /(?:无法|不能|没有|未启用|不具备|没法).{0,24}(?:联网|实时|搜索|访问互联网|浏览网页)|(?:cannot|can't|unable).{0,30}(?:browse|search|internet|web)/i;
const ORCHESTRATOR_COMMAND_PATTERN = /(^|\s)(?:\/|\|)(?:deep|normal|shallow|skills)\b/i;
const EXPLICIT_SKILL_PATTERN = /(^|\s)\$[\w-]+\b/i;
