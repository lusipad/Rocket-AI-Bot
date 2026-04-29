import type { RequestContext } from '../bot/message-handler.js';
import type { SkillActivationSource } from '../agent/orchestrator.js';
import type { ToolSource } from '../tools/source.js';

export interface AgentActor {
  id: string;
  username: string;
  displayName?: string;
  kind?: 'human' | 'system';
}

export interface AgentChannel {
  kind: 'rocketchat' | 'scheduler' | 'cli' | 'http' | string;
  roomId?: string;
  roomName?: string;
  roomType?: RequestContext['roomType'];
  threadId?: string;
}

export interface AgentConversationMessage {
  role: 'user' | 'assistant';
  username: string;
  text: string;
  images?: string[];
  isSummary?: boolean;
}

export interface AgentAttachment {
  type: 'image';
  url: string;
}

export interface AgentRequest {
  id: string;
  input: string;
  actor: AgentActor;
  channel: AgentChannel;
  conversation?: AgentConversationMessage[];
  attachments?: AgentAttachment[];
  metadata?: {
    triggerMessageId?: string;
    timestamp?: Date;
  };
}

export type AgentRequestType =
  | 'command'
  | 'public_realtime'
  | 'ado_file_review'
  | 'ado_file_lookup'
  | 'code_query'
  | 'ado_query'
  | 'pr_review'
  | 'pipeline_monitor'
  | 'work_item_report'
  | 'discussion'
  | 'scheduler'
  | 'general';

export interface AgentTrace {
  activeSkills: string[];
  skillSources: Record<string, SkillActivationSource>;
  usedTools: string[];
  rounds: number;
  status: 'success' | 'error';
  finishReason?: string;
  error?: string;
  webSearchUsed?: boolean;
  modelUsed?: string;
  modelMode?: 'normal' | 'deep';
  requestType?: AgentRequestType;
  sources?: ToolSource[];
}

export interface AgentResponseMessage {
  type: 'text';
  text: string;
}

export interface AgentResponse {
  requestId: string;
  status: 'success' | 'error';
  text: string;
  messages: AgentResponseMessage[];
  finishReason?: string;
  error?: string;
  model: string;
  modelMode?: 'normal' | 'deep';
  requestType?: AgentRequestType;
  sources?: ToolSource[];
  trace: AgentTrace;
}

export type { AgentCapability } from './capabilities.js';
