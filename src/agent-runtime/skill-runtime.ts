import type { AgentRequest } from '../agent-core/types.js';
import type { AgentSkillCatalog, AgentSkillDetail } from './skill-catalog.js';

export type AgentSkillRouteKind = 'skill' | 'disabled_skill' | 'fallback';

export interface AgentSkillRoute {
  kind: AgentSkillRouteKind;
  originalInput: string;
  cleanedInput: string;
  skills: AgentSkillDetail[];
  disabledSkillNames: string[];
}

export class SkillRuntime {
  constructor(private readonly catalog: AgentSkillCatalog) {}

  route(request: Pick<AgentRequest, 'input'>): AgentSkillRoute {
    const match = this.catalog.matchExplicit(request.input);

    if (match.skills.length > 0) {
      return {
        kind: 'skill',
        originalInput: request.input,
        cleanedInput: match.cleanedInput,
        skills: match.skills,
        disabledSkillNames: match.disabledSkillNames,
      };
    }

    if (match.disabledSkillNames.length > 0) {
      return {
        kind: 'disabled_skill',
        originalInput: request.input,
        cleanedInput: match.cleanedInput,
        skills: [],
        disabledSkillNames: match.disabledSkillNames,
      };
    }

    return {
      kind: 'fallback',
      originalInput: request.input,
      cleanedInput: request.input,
      skills: [],
      disabledSkillNames: [],
    };
  }
}
