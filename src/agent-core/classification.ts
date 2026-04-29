import type { AgentRequest, AgentRequestType, AgentResponse } from './types.js';

export function classifyAgentInteraction(
  request: AgentRequest,
  response?: Pick<AgentResponse, 'finishReason' | 'trace' | 'requestType'>,
): AgentRequestType {
  if (response?.requestType) {
    return response.requestType;
  }

  const finishReason = response?.finishReason ?? response?.trace.finishReason;
  const tools = new Set(response?.trace.usedTools ?? []);
  const skills = new Set(response?.trace.activeSkills ?? []);
  const input = request.input;

  if (isCommand(input) || isCommandFinishReason(finishReason)) {
    return 'command';
  }
  if (finishReason === 'web_search_fast_path' || response?.trace.webSearchUsed === true) {
    return 'public_realtime';
  }
  if (finishReason === 'ado_url_fast_path') {
    return isReviewRequest(input) ? 'ado_file_review' : 'ado_file_lookup';
  }
  if (tools.has('search_code') || tools.has('read_file') || skills.has('code-lookup')) {
    return 'code_query';
  }
  if (tools.has('azure_devops') || tools.has('azure_devops_server_rest') || skills.has('ado-lookup')) {
    if (isPrReviewRequest(input)) {
      return 'pr_review';
    }
    if (isPipelineRequest(input)) {
      return 'pipeline_monitor';
    }
    if (isWorkItemRequest(input)) {
      return 'work_item_report';
    }
    return 'ado_query';
  }
  if (request.channel.kind === 'scheduler' || request.actor.kind === 'system') {
    return 'scheduler';
  }
  if (isDiscussionRequest(input, request.conversation?.length ?? 0)) {
    return 'discussion';
  }

  return 'general';
}

export function isAgentRequestType(value: unknown): value is AgentRequestType {
  return typeof value === 'string' && REQUEST_TYPES.includes(value as AgentRequestType);
}

const REQUEST_TYPES: AgentRequestType[] = [
  'command',
  'public_realtime',
  'ado_file_review',
  'ado_file_lookup',
  'code_query',
  'ado_query',
  'pr_review',
  'pipeline_monitor',
  'work_item_report',
  'discussion',
  'scheduler',
  'general',
];

function isCommand(input: string): boolean {
  return /(^|\s)(?:\/|\|)(?:help|status|context|reset-context|clear-context|skills|normal|shallow|deep)\b/i.test(input);
}

function isCommandFinishReason(finishReason: string | undefined): boolean {
  return Boolean(finishReason && (
    finishReason.startsWith('command_')
    || finishReason === 'skill_help'
    || finishReason.endsWith('_deep_mode')
    || finishReason === 'context_reset'
  ));
}

function isReviewRequest(input: string): boolean {
  return /review|审查|评审|风险|看下|看看/i.test(input);
}

function isPrReviewRequest(input: string): boolean {
  return /(?:\bpr\b|pull\s*request|合并请求|审查|review|评审)/i.test(input);
}

function isPipelineRequest(input: string): boolean {
  return /pipeline|构建|build|ci|部署|release/i.test(input);
}

function isWorkItemRequest(input: string): boolean {
  return /work\s*item|工作项|bug|task|user\s*story|需求|阻塞|超期|负责人|风险/i.test(input);
}

function isDiscussionRequest(input: string, conversationLength: number): boolean {
  return conversationLength >= 8 || /总结|梳理|分歧|待办|owner|刚才|上面|讨论|结论/i.test(input);
}
