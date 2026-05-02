import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/helpers.js';
import {
  createDefaultAgentDefinition,
  type AgentChannelKind,
  type AgentDefinition,
  type AgentSkillPolicy,
} from './definition.js';

export interface AgentRegistryOptions {
  rootDir?: string;
  defaultModel: string;
  defaultDeepModel?: string;
}

export class AgentRegistry {
  private readonly agents: AgentDefinition[];
  private readonly defaultAgent: AgentDefinition;

  constructor(options: AgentRegistryOptions) {
    const rootDir = options.rootDir ?? path.join('data', 'agents');
    ensureDir(rootDir);

    const loadedAgents = loadAgents(rootDir);
    this.agents = loadedAgents.length > 0
      ? loadedAgents
      : [createDefaultAgentDefinition({
        model: options.defaultModel,
        deepModel: options.defaultDeepModel,
      })];
    this.defaultAgent = this.agents[0];
  }

  list(): AgentDefinition[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  getDefault(): AgentDefinition {
    return { ...this.defaultAgent };
  }

  resolveForChannel(_channel: AgentChannelKind): AgentDefinition {
    return this.getDefault();
  }
}

function loadAgents(rootDir: string): AgentDefinition[] {
  return fs.readdirSync(rootDir)
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => loadAgentFile(path.join(rootDir, file)))
    .filter((agent): agent is AgentDefinition => Boolean(agent));
}

function loadAgentFile(filePath: string): AgentDefinition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid agent definition ${filePath}: ${String(error)}`);
  }

  if (isRecord(parsed) && parsed.enabled === false) {
    return null;
  }

  return normalizeAgentDefinition(parsed, filePath);
}

function normalizeAgentDefinition(value: unknown, filePath: string): AgentDefinition {
  if (!isRecord(value)) {
    throw invalid(filePath, 'definition must be an object');
  }

  const id = requireCleanText(value.id, filePath, 'id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) {
    throw invalid(filePath, 'id must use letters, numbers, "-" or "_"');
  }

  const name = requireCleanText(value.name, filePath, 'name');
  const model = requireCleanText(value.model, filePath, 'model');
  const channels = normalizeChannels(value.channels, filePath);
  const instructions = requireCleanText(value.instructions, filePath, 'instructions');
  const skillPolicy = normalizeSkillPolicy(value.skillPolicy, filePath);
  const contextPolicyRef = requireCleanText(value.contextPolicyRef, filePath, 'contextPolicyRef');
  const description = optionalCleanText(value.description);
  const deepModel = optionalCleanText(value.deepModel);

  return {
    id,
    name,
    ...(description ? { description } : {}),
    model,
    ...(deepModel ? { deepModel } : {}),
    channels,
    instructions,
    skillPolicy,
    contextPolicyRef,
  };
}

function normalizeChannels(value: unknown, filePath: string): AgentChannelKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(filePath, 'channels must be a non-empty array');
  }

  return value.map((channel, index) => {
    if (typeof channel !== 'string' || channel.trim().length === 0) {
      throw invalid(filePath, `channels[${index}] must be a non-empty string`);
    }
    return channel.trim();
  });
}

function normalizeSkillPolicy(value: unknown, filePath: string): AgentSkillPolicy {
  if (!isRecord(value)) {
    throw invalid(filePath, 'skillPolicy must be an object');
  }

  if (value.mode === 'enabled_project_skills') {
    return { mode: 'enabled_project_skills' };
  }

  if (value.mode === 'allowlist') {
    if (!Array.isArray(value.allowedSkills)) {
      throw invalid(filePath, 'allowlist skillPolicy requires allowedSkills');
    }
    return {
      mode: 'allowlist',
      allowedSkills: value.allowedSkills.map((skill, index) => {
        if (typeof skill !== 'string' || skill.trim().length === 0) {
          throw invalid(filePath, `allowedSkills[${index}] must be a non-empty string`);
        }
        return skill.trim();
      }),
    };
  }

  throw invalid(filePath, 'unknown skillPolicy mode');
}

function requireCleanText(value: unknown, filePath: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(filePath, `${field} must be a non-empty string`);
  }

  return value.trim();
}

function optionalCleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function invalid(filePath: string, reason: string): Error {
  return new Error(`Invalid agent definition ${filePath}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
