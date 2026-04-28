import type { RequestContext } from '../../bot/message-handler.js';
import type { Config } from '../../config/schema.js';
import type { ChatOptions, LLMClient } from '../../llm/client.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { AgentCapability } from '../capabilities.js';
import type { AgentRequest, AgentResponse } from '../types.js';

type ModelMode = { mode: 'normal' | 'deep'; model: string };

interface AzureDevOpsFileUrl {
  project?: string;
  repository: string;
  path: string;
  versionLabel?: string;
  versionQuery: Record<string, string>;
}

export interface AzureDevOpsFileUrlCapabilityOptions {
  config: Config;
  llm: LLMClient;
  registry: ToolRegistry;
  resolveModelMode?: (request: AgentRequest) => ModelMode;
  resolveRequestContext?: (request: AgentRequest) => RequestContext | undefined;
}

export function createAzureDevOpsFileUrlCapability(
  options: AzureDevOpsFileUrlCapabilityOptions,
): AgentCapability {
  return {
    id: 'azure-devops-file-url',
    description: 'Fast path for read-only Azure DevOps Server file URL explain/review requests.',
    priority: 90,
    canHandle: (request) => parseAzureDevOpsFileUrl(request.input) !== null,
    handle: async (request) => handleAzureDevOpsFileUrl(request, options),
  };
}

async function handleAzureDevOpsFileUrl(
  request: AgentRequest,
  options: AzureDevOpsFileUrlCapabilityOptions,
): Promise<AgentResponse> {
  const fileUrl = parseAzureDevOpsFileUrl(request.input);
  if (!fileUrl) {
    throw new Error('请求不包含 Azure DevOps 文件 URL');
  }

  const modelMode = options.resolveModelMode?.(request)
    ?? { mode: 'normal', model: options.llm.getModel() };
  const requestContext = options.resolveRequestContext?.(request);
  const usedToolNames = new Set<string>();

  try {
    const reply = await buildAzureDevOpsFileReply(
      request,
      fileUrl,
      options,
      modelMode,
      requestContext,
      usedToolNames,
    );

    return buildAgentResponse({
      request,
      modelMode,
      status: 'success',
      text: decorateReply(reply, usedToolNames),
      finishReason: 'ado_url_fast_path',
      usedToolNames,
    });
  } catch (error) {
    return buildAgentResponse({
      request,
      modelMode,
      status: 'error',
      text: '处理 Azure DevOps Server 文件 URL 时失败，请稍后重试。',
      finishReason: 'ado_url_error',
      error: String(error),
      usedToolNames,
    });
  }
}

async function buildAzureDevOpsFileReply(
  request: AgentRequest,
  fileUrl: AzureDevOpsFileUrl,
  options: AzureDevOpsFileUrlCapabilityOptions,
  modelMode: ModelMode,
  requestContext: RequestContext | undefined,
  usedToolNames: Set<string>,
): Promise<string> {
  const project = fileUrl.project
    ?? options.config.azureDevOpsServer?.project
    ?? options.config.azureDevOps?.project
    ?? fileUrl.repository;
  const toolResult = await options.registry.execute('azure_devops_server_rest', {
    method: 'GET',
    area: 'git',
    project,
    resource: `repositories/${fileUrl.repository}/items`,
    query: {
      path: fileUrl.path,
      includeContent: 'true',
      ...fileUrl.versionQuery,
    },
  }, {
    request: requestContext,
    requestId: request.id,
  });
  usedToolNames.add('azure_devops_server_rest');

  if (!toolResult.success) {
    return `读取 Azure DevOps Server 文件失败：${String(toolResult.data.error ?? '未知错误')}`;
  }

  const content = extractRepositoryFileContent(toolResult.data.result);
  if (!content) {
    return '已读取 Azure DevOps Server 文件，但响应中没有可 review 的文本内容。';
  }

  const reviewRequest = isReviewRequest(request.input);
  const baseContent = reviewRequest && shouldFetchMainBaseline(fileUrl)
    ? await readMainBaselineFile(fileUrl, project, request, options, requestContext, usedToolNames)
    : undefined;
  const numberedContent = addLineNumbers(content, 24000);
  const numberedBaseContent = baseContent ? addLineNumbers(baseContent, 16000) : undefined;
  const modeInstruction = reviewRequest
    ? '请做代码 review。优先审查目标版本相对 main 的变化；按严重程度列出具体问题，包含行号；如果没有明确问题，直接说没有发现明确风险，并补充残余风险。'
    : '请按用户请求简洁说明这个文件内容；不要编造文件中不存在的信息。';
  const response = await options.llm.chat([
    {
      role: 'system',
      content:
        '你是 RocketBot，正在处理 Azure DevOps Server 仓库文件的只读查看请求。'
        + '禁止建议你已经修改、提交、推送或创建 PR。回复中文，结论优先。',
    },
    {
      role: 'user',
      content:
        `${modeInstruction}\n\n`
        + `仓库: ${fileUrl.repository}\n`
        + `项目: ${fileUrl.project ?? '(默认项目)'}\n`
        + `文件: ${fileUrl.path}\n`
        + `版本: ${fileUrl.versionLabel ?? 'main/default'}\n\n`
        + (numberedBaseContent
          ? `main 基线内容（带行号）:\n${numberedBaseContent}\n\n`
          : reviewRequest && shouldFetchMainBaseline(fileUrl)
            ? 'main 基线内容：未能读取，可能是新增文件或 main 中不存在同路径文件。\n\n'
            : '')
        + `内容（带行号）:\n${numberedContent}`,
    },
  ], [], buildChatOptions(modelMode));

  return response.choices[0]?.message?.content?.trim() || '已读取文件，但无法生成 review 结果。';
}

async function readMainBaselineFile(
  fileUrl: AzureDevOpsFileUrl,
  project: string,
  request: AgentRequest,
  options: AzureDevOpsFileUrlCapabilityOptions,
  requestContext: RequestContext | undefined,
  usedToolNames: Set<string>,
): Promise<string | undefined> {
  const result = await options.registry.execute('azure_devops_server_rest', {
    method: 'GET',
    area: 'git',
    project,
    resource: `repositories/${fileUrl.repository}/items`,
    query: {
      path: fileUrl.path,
      includeContent: 'true',
      'versionDescriptor.version': 'main',
      'versionDescriptor.versionType': 'branch',
    },
  }, {
    request: requestContext,
    requestId: request.id,
  });
  usedToolNames.add('azure_devops_server_rest');

  if (!result.success) {
    return undefined;
  }

  return extractRepositoryFileContent(result.data.result);
}

function buildAgentResponse(input: {
  request: AgentRequest;
  modelMode: ModelMode;
  status: 'success' | 'error';
  text: string;
  finishReason: string;
  error?: string;
  usedToolNames: Set<string>;
}): AgentResponse {
  const usedTools = Array.from(input.usedToolNames);
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
      usedTools,
      rounds: 1,
      status: input.status,
      finishReason: input.finishReason,
      error: input.error,
      webSearchUsed: false,
      modelUsed: input.modelMode.mode === 'deep' ? input.modelMode.model : undefined,
      modelMode: input.modelMode.mode,
    },
  };
}

function buildChatOptions(modelMode: ModelMode): ChatOptions | undefined {
  if (modelMode.mode !== 'deep') {
    return undefined;
  }

  return { model: modelMode.model };
}

function decorateReply(reply: string, usedToolNames: Set<string>): string {
  if (usedToolNames.size === 0) {
    return reply;
  }

  return `已使用工具: ${Array.from(usedToolNames).join(', ')}\n\n${reply}`;
}

function parseAzureDevOpsFileUrl(message: string): AzureDevOpsFileUrl | null {
  const match = message.match(/https?:\/\/\S+\/_git\/\S+/i);
  if (!match) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(match[0].replace(/[)\].,，。]+$/u, ''));
  } catch {
    return null;
  }

  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === '_git');
  if (gitIndex < 0 || !parts[gitIndex + 1]) {
    return null;
  }

  const project = gitIndex >= 2 ? parts[gitIndex - 1] : undefined;
  const repository = parts[gitIndex + 1];
  const filePath = url.searchParams.get('path') || '/';
  const versionQuery = buildVersionQuery(url.searchParams);

  return {
    project,
    repository,
    path: filePath,
    versionLabel: versionQuery['versionDescriptor.version'],
    versionQuery,
  };
}

function buildVersionQuery(searchParams: URLSearchParams): Record<string, string> {
  const descriptorVersion = searchParams.get('versionDescriptor.version');
  if (descriptorVersion) {
    return {
      'versionDescriptor.version': descriptorVersion,
      'versionDescriptor.versionType': searchParams.get('versionDescriptor.versionType') || 'branch',
    };
  }

  const uiVersion = searchParams.get('version');
  if (!uiVersion) {
    return {
      'versionDescriptor.version': 'main',
      'versionDescriptor.versionType': 'branch',
    };
  }

  if (uiVersion.startsWith('GB')) {
    return {
      'versionDescriptor.version': uiVersion.slice(2),
      'versionDescriptor.versionType': 'branch',
    };
  }
  if (uiVersion.startsWith('GC')) {
    return {
      'versionDescriptor.version': uiVersion.slice(2),
      'versionDescriptor.versionType': 'commit',
    };
  }
  if (uiVersion.startsWith('GT')) {
    return {
      'versionDescriptor.version': uiVersion.slice(2),
      'versionDescriptor.versionType': 'tag',
    };
  }

  return {
    'versionDescriptor.version': uiVersion,
    'versionDescriptor.versionType': 'branch',
  };
}

function extractRepositoryFileContent(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (Array.isArray(record.value)) {
    const firstWithContent = record.value.find((item) => (
      item && typeof item === 'object' && typeof (item as Record<string, unknown>).content === 'string'
    ));
    if (firstWithContent) {
      return (firstWithContent as Record<string, string>).content;
    }
  }

  return undefined;
}

function addLineNumbers(content: string, maxChars: number): string {
  const numbered = content
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  if (numbered.length <= maxChars) {
    return numbered;
  }

  return `${numbered.slice(0, maxChars)}\n...内容过长，后续部分已截断...`;
}

function isReviewRequest(message: string): boolean {
  return /review|审查|评审|风险|看下|看看/i.test(message);
}

function shouldFetchMainBaseline(fileUrl: AzureDevOpsFileUrl): boolean {
  const version = fileUrl.versionQuery['versionDescriptor.version'];
  return Boolean(version && version !== 'main');
}
