import type { AgentRequest } from '../agent-core/types.js';
import type { AgentSkillCatalog, AgentSkillDetail } from './skill-catalog.js';

export type AgentSkillRouteKind = 'skill' | 'disabled_skill' | 'fallback';
export type AgentSkillActivationSource = 'explicit';

export interface AgentSkillRoute {
  kind: AgentSkillRouteKind;
  originalInput: string;
  cleanedInput: string;
  skills: AgentSkillDetail[];
  skillSources: Record<string, AgentSkillActivationSource>;
  disabledSkillNames: string[];
}

export class SkillRuntime {
  constructor(private readonly catalog: AgentSkillCatalog) {}

  route(request: Pick<AgentRequest, 'input'>): AgentSkillRoute {
    const explicitMatch = this.catalog.matchExplicit(request.input);
    const naturalMatch = this.catalog.matchNaturalLanguage(explicitMatch.cleanedInput);
    const skillsByName = new Map<string, AgentSkillDetail>();
    const skillSources: Record<string, AgentSkillActivationSource> = {};
    const disabledSkillNames = new Set<string>(explicitMatch.disabledSkillNames);

    for (const skill of explicitMatch.skills) {
      skillsByName.set(skill.name, skill);
      skillSources[skill.name] = 'explicit';
    }
    for (const skill of naturalMatch.skills) {
      skillsByName.set(skill.name, skill);
      skillSources[skill.name] = 'explicit';
    }
    for (const name of naturalMatch.disabledSkillNames) {
      disabledSkillNames.add(name);
    }

    const skills = Array.from(skillsByName.values());
    if (skills.length > 0) {
      return {
        kind: 'skill',
        originalInput: request.input,
        cleanedInput: naturalMatch.cleanedInput,
        skills,
        skillSources,
        disabledSkillNames: Array.from(disabledSkillNames),
      };
    }

    if (disabledSkillNames.size > 0) {
      return {
        kind: 'disabled_skill',
        originalInput: request.input,
        cleanedInput: naturalMatch.cleanedInput,
        skills: [],
        skillSources: {},
        disabledSkillNames: Array.from(disabledSkillNames),
      };
    }

    return {
      kind: 'fallback',
      originalInput: request.input,
      cleanedInput: request.input,
      skills: [],
      skillSources: {},
      disabledSkillNames: [],
    };
  }
}
