import { splitMessage } from '../../agent/orchestrator.js';
import type { AgentResponse } from '../../agent-core/types.js';

export function renderRocketChatReply(response: AgentResponse): string[] {
  return splitMessage(response.text);
}
