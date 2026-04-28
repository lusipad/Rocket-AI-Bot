import type { RequestContext } from '../bot/message-handler.js';
import type { SkillActivationSource } from '../agent/orchestrator.js';

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
  trace: AgentTrace;
}

export type { AgentCapability } from './capabilities.js';
