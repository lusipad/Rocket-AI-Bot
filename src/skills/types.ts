export interface SkillSummary {
  name: string;
  description: string;
  allowedTools: string[];
}

export interface InstalledSkillSummary extends SkillSummary {
  enabled: boolean;
  filePath: string;
}

export interface InstalledSkillDetail extends InstalledSkillSummary {
  directory: string;
  instructions: string;
}

export interface SkillDefinition extends SkillSummary {
  instructions: string;
  directory: string;
  filePath: string;
}

export interface ExplicitSkillMatch {
  skills: SkillDefinition[];
  cleanedMessage: string;
  disabledSkillNames: string[];
}
