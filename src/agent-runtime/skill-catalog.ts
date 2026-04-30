import { SkillRegistry } from '../skills/registry.js';
import type { ExplicitSkillMatch, SkillDefinition } from '../skills/types.js';

export interface AgentSkillManifest {
  name: string;
  description: string;
  allowedTools: string[];
  enabled: boolean;
  filePath: string;
}

export interface AgentSkillDetail extends AgentSkillManifest {
  directory: string;
  instructions: string;
}

export interface AgentSkillMatch {
  skills: AgentSkillDetail[];
  cleanedInput: string;
  disabledSkillNames: string[];
}

export interface AgentSkillCatalog {
  listManifests(): AgentSkillManifest[];
  getManifest(name: string): AgentSkillManifest | undefined;
  load(name: string): AgentSkillDetail | undefined;
  matchExplicit(input: string): AgentSkillMatch;
}

export class ProjectSkillCatalog implements AgentSkillCatalog {
  constructor(private readonly registry: SkillRegistry) {}

  listManifests(): AgentSkillManifest[] {
    return this.registry.listInstalled().map((skill) => ({
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      enabled: skill.enabled,
      filePath: skill.filePath,
    }));
  }

  getManifest(name: string): AgentSkillManifest | undefined {
    return this.listManifests().find((skill) => skill.name === name);
  }

  load(name: string): AgentSkillDetail | undefined {
    const skill = this.registry.getInstalled(name);
    if (!skill) {
      return undefined;
    }

    return {
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      enabled: skill.enabled,
      filePath: skill.filePath,
      directory: skill.directory,
      instructions: skill.instructions,
    };
  }

  matchExplicit(input: string): AgentSkillMatch {
    return toAgentSkillMatch(this.registry.findExplicitSkills(input));
  }
}

function toAgentSkillMatch(match: ExplicitSkillMatch): AgentSkillMatch {
  return {
    skills: match.skills.map(toAgentSkillDetail),
    cleanedInput: match.cleanedMessage,
    disabledSkillNames: match.disabledSkillNames,
  };
}

function toAgentSkillDetail(skill: SkillDefinition): AgentSkillDetail {
  return {
    name: skill.name,
    description: skill.description,
    allowedTools: skill.allowedTools,
    enabled: true,
    filePath: skill.filePath,
    directory: skill.directory,
    instructions: skill.instructions,
  };
}
