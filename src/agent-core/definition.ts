export type AgentChannelKind = 'rocketchat' | 'scheduler' | 'cli' | 'http' | string;

export type AgentSkillPolicy =
  | {
    mode: 'enabled_project_skills';
  }
  | {
    mode: 'allowlist';
    allowedSkills: string[];
  };

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  model: string;
  deepModel?: string;
  channels: AgentChannelKind[];
  instructions: string;
  skillPolicy: AgentSkillPolicy;
  contextPolicyRef: string;
}

export interface AgentDefinitionInput {
  model: string;
  deepModel?: string;
}

export interface AgentIdentity {
  id: string;
  name: string;
}

export function createDefaultAgentDefinition(input: AgentDefinitionInput): AgentDefinition {
  return {
    id: 'rocketbot-default',
    name: 'RocketBot Default Agent',
    description: 'Default Rocket.Chat and scheduler agent for RocketBot.',
    model: input.model,
    deepModel: input.deepModel,
    channels: ['rocketchat', 'scheduler'],
    instructions:
      '你是运行在 Rocket.Chat 中的企业 AI 助手。'
      + '保持普通聊天体验自然，按当前上下文、skills 和工具能力回答。',
    skillPolicy: {
      mode: 'enabled_project_skills',
    },
    contextPolicyRef: 'default',
  };
}

export function toAgentIdentity(definition: AgentDefinition): AgentIdentity {
  return {
    id: definition.id,
    name: definition.name,
  };
}
