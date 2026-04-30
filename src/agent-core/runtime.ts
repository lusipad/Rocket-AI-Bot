import type { RequestContext } from '../bot/message-handler.js';
import { Orchestrator, type ModelModePreview, type OrchestratorTrace } from '../agent/orchestrator.js';
import type { LLMClient } from '../llm/client.js';
import type {
  AgentConversationMessage,
  AgentCapability,
  AgentRequest,
  AgentResponse,
  AgentTrace,
} from './types.js';
import { CapabilityRegistry, RequestRouter } from './capabilities.js';
import { classifyAgentInteraction } from './classification.js';
import { dedupeSources } from '../tools/source.js';

export interface AgentRuntimeSkillRoute {
  kind: 'skill' | 'disabled_skill' | 'fallback';
  cleanedInput: string;
  skills: Array<{ name: string }>;
  disabledSkillNames: string[];
}

export interface AgentRuntimeOptions {
  skillRuntime?: {
    route(request: Pick<AgentRequest, 'input'>): AgentRuntimeSkillRoute;
  };
}

export class AgentRuntime {
  private readonly router: RequestRouter;
  private readonly skillRuntime?: AgentRuntimeOptions['skillRuntime'];

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly llm: LLMClient,
    capabilities: AgentCapability[] = [],
    options: AgentRuntimeOptions = {},
  ) {
    this.skillRuntime = options.skillRuntime;
    const registry = new CapabilityRegistry();
    for (const capability of capabilities) {
      registry.register(capability);
    }
    registry.register({
      id: 'legacy-orchestrator',
      description: 'Fallback bridge to the existing Orchestrator while Agent Core is being extracted.',
      priority: -1000,
      canHandle: () => true,
      handle: (request) => this.handleWithOrchestrator(request),
    });
    this.router = new RequestRouter(registry);
  }

  previewModelMode(request: AgentRequest): ModelModePreview {
    return this.orchestrator.previewModelMode(
      request.actor.id,
      request.input,
      toRequestContext(request),
    );
  }

  async handle(request: AgentRequest): Promise<AgentResponse> {
    const skillRoute = this.skillRuntime?.route(request);
    if (skillRoute?.kind === 'disabled_skill') {
      return annotateResponse(
        request,
        createDisabledSkillResponse(request, this.llm.getModel(), skillRoute.disabledSkillNames),
      );
    }
    if (skillRoute?.kind === 'skill') {
      const response = await this.handleWithOrchestrator(request);
      return annotateResponse(request, response);
    }

    const response = await this.router.handle(request);
    return annotateResponse(request, response);
  }

  private async handleWithOrchestrator(request: AgentRequest): Promise<AgentResponse> {
    const trace = createTrace();
    const reply = await this.orchestrator.handle(
      request.actor.id,
      request.actor.username,
      request.input,
      toOrchestratorConversation(request.conversation ?? []),
      request.attachments?.map((attachment) => attachment.url) ?? [],
      toRequestContext(request),
      {
        requestId: request.id,
        trace,
      },
    );

    return {
      requestId: request.id,
      status: trace.status,
      text: reply,
      messages: [{ type: 'text', text: reply }],
      finishReason: trace.finishReason,
      error: trace.error,
      model: trace.modelUsed ?? this.llm.getModel(),
      modelMode: trace.modelMode,
      trace: toAgentTrace(trace),
    };
  }
}

function createDisabledSkillResponse(request: AgentRequest, model: string, disabledSkillNames: string[]): AgentResponse {
  const text = `以下 skill 已安装但未启用：${disabledSkillNames.join(', ')}。请先在管理页启用后再使用。`;
  return {
    requestId: request.id,
    status: 'success',
    text,
    messages: [{ type: 'text', text }],
    finishReason: 'disabled_skill',
    model,
    trace: {
      activeSkills: [],
      skillSources: {},
      usedTools: [],
      rounds: 0,
      status: 'success',
      finishReason: 'disabled_skill',
    },
  };
}

function createTrace(): OrchestratorTrace {
  return {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
    webSearchUsed: false,
  };
}

export function toRequestContext(request: AgentRequest): RequestContext | undefined {
  if (!request.channel.roomId || !request.metadata?.triggerMessageId || !request.metadata.timestamp) {
    return undefined;
  }

  return {
    requestId: request.id,
    roomId: request.channel.roomId,
    roomType: request.channel.roomType,
    threadId: request.channel.threadId,
    triggerMessageId: request.metadata.triggerMessageId,
    timestamp: request.metadata.timestamp,
  };
}

function toOrchestratorConversation(messages: AgentConversationMessage[]): AgentConversationMessage[] {
  return messages;
}

function toAgentTrace(trace: OrchestratorTrace): AgentTrace {
  return {
    activeSkills: trace.activeSkills,
    skillSources: trace.skillSources,
    usedTools: trace.usedTools,
    rounds: trace.rounds,
    status: trace.status,
    finishReason: trace.finishReason,
    error: trace.error,
    webSearchUsed: trace.webSearchUsed,
    modelUsed: trace.modelUsed,
    modelMode: trace.modelMode,
    sources: trace.sources,
  };
}

function annotateResponse(request: AgentRequest, response: AgentResponse): AgentResponse {
  const requestType = classifyAgentInteraction(request, response);
  const sources = dedupeSources([
    ...(response.sources ?? []),
    ...(response.trace.sources ?? []),
  ]);

  return {
    ...response,
    requestType,
    sources,
    trace: {
      ...response.trace,
      requestType,
      sources,
    },
  };
}
