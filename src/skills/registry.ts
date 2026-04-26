import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ensureDir, isPathWithin } from '../utils/helpers.js';
import type { Logger } from '../utils/logger.js';
import type {
  ExplicitSkillMatch,
  InstalledSkillDetail,
  InstalledSkillSummary,
  SkillDefinition,
  SkillSummary,
} from './types.js';

const DEFAULT_SKILLS_ROOT = path.resolve(process.cwd(), '.agents', 'skills');
const DEFAULT_ENABLED_STATE_PATH = path.resolve(process.cwd(), 'data', 'skills', 'state.json');

interface SkillMetadata extends SkillSummary {
  directory: string;
  filePath: string;
}

export class SkillRegistry {
  private readonly logger?: Logger;
  private readonly skills = new Map<string, SkillMetadata>();
  private readonly enabledSkillNames = new Set<string>();

  constructor(
    private readonly skillsRoot = DEFAULT_SKILLS_ROOT,
    logger?: Logger,
    private readonly statePath = DEFAULT_ENABLED_STATE_PATH,
  ) {
    this.logger = logger;
    ensureDir(path.dirname(this.statePath));
    this.load();
  }

  list(): SkillSummary[] {
    return this.listInstalled()
      .filter((skill) => skill.enabled)
      .map(({ name, description, allowedTools }) => ({
        name,
        description,
        allowedTools,
      }));
  }

  listInstalled(): InstalledSkillSummary[] {
    return Array.from(this.skills.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, allowedTools, filePath }) => ({
        name,
        description,
        allowedTools,
        filePath,
        enabled: this.isEnabled(name),
      }));
  }

  get(name: string): SkillDefinition | undefined {
    return this.hydrateSkill(this.skills.get(name));
  }

  getInstalled(name: string): InstalledSkillDetail | undefined {
    const metadata = this.skills.get(name);
    const skill = this.hydrateSkill(metadata);
    if (!metadata || !skill) {
      return undefined;
    }

    return {
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      filePath: skill.filePath,
      enabled: this.isEnabled(skill.name),
      directory: skill.directory,
      instructions: skill.instructions,
    };
  }

  getEnabled(name: string): SkillDefinition | undefined {
    if (!this.isEnabled(name)) {
      return undefined;
    }
    return this.get(name);
  }

  isEnabled(name: string): boolean {
    return this.enabledSkillNames.has(name);
  }

  setEnabled(name: string, enabled: boolean): InstalledSkillSummary {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`未找到 skill: ${name}`);
    }

    if (enabled) {
      this.enabledSkillNames.add(name);
    } else {
      this.enabledSkillNames.delete(name);
    }

    this.saveState();
    return {
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      filePath: skill.filePath,
      enabled: this.isEnabled(name),
    };
  }

  reload(): InstalledSkillSummary[] {
    this.skills.clear();
    this.enabledSkillNames.clear();
    this.load();
    return this.listInstalled();
  }

  installFromDirectory(sourceDir: string): InstalledSkillDetail {
    const resolvedSourceDir = path.resolve(sourceDir);
    const filePath = path.join(resolvedSourceDir, 'SKILL.md');

    if (!fs.existsSync(filePath)) {
      throw new Error(`未找到 SKILL.md: ${filePath}`);
    }

    const skill = parseSkillMetadata(filePath);
    const targetDir = path.join(this.skillsRoot, skill.name);

    ensureDir(this.skillsRoot);

    if (fs.existsSync(targetDir)) {
      throw new Error(`skill 已安装: ${skill.name}`);
    }

    fs.cpSync(resolvedSourceDir, targetDir, {
      recursive: true,
      filter: (entry) => {
        const baseName = path.basename(entry);
        return baseName !== '.git' && baseName !== 'node_modules';
      },
    });
    this.reload();

    const installed = this.getInstalled(skill.name);
    if (!installed) {
      throw new Error(`安装后未找到 skill: ${skill.name}`);
    }

    return installed;
  }

  remove(name: string): InstalledSkillSummary[] {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`未找到 skill: ${name}`);
    }

    if (!isPathWithin(this.skillsRoot, skill.directory)) {
      throw new Error(`skill 路径不在项目 skills 目录内: ${skill.directory}`);
    }

    fs.rmSync(skill.directory, { recursive: true, force: true });
    return this.reload();
  }

  findExplicitSkills(message: string): ExplicitSkillMatch {
    let cleanedMessage = message;
    const matches: SkillDefinition[] = [];
    const disabledSkillNames = new Set<string>();

    for (const skill of this.skills.values()) {
      const token = `$${skill.name}`;
      if (!cleanedMessage.includes(token)) {
        continue;
      }

      cleanedMessage = cleanedMessage.split(token).join(' ');

      if (this.isEnabled(skill.name)) {
        const hydrated = this.hydrateSkill(skill);
        if (hydrated) {
          matches.push(hydrated);
        }
      } else {
        disabledSkillNames.add(skill.name);
      }
    }

    return {
      skills: uniqueSkills(matches),
      cleanedMessage: cleanedMessage.replace(/\s+/g, ' ').trim(),
      disabledSkillNames: Array.from(disabledSkillNames),
    };
  }

  findNaturalLanguageSkills(message: string): ExplicitSkillMatch {
    let cleanedMessage = message;
    const matches: SkillDefinition[] = [];
    const disabledSkillNames = new Set<string>();

    for (const skill of this.skills.values()) {
      const patterns = buildNaturalLanguageSkillPatterns(skill.name);
      const matched = patterns.some((pattern) => pattern.test(cleanedMessage));
      if (!matched) {
        continue;
      }

      cleanedMessage = patterns.reduce(
        (current, pattern) => current.replace(pattern, '$1'),
        cleanedMessage,
      );

      if (this.isEnabled(skill.name)) {
        const hydrated = this.hydrateSkill(skill);
        if (hydrated) {
          matches.push(hydrated);
        }
      } else {
        disabledSkillNames.add(skill.name);
      }
    }

    return {
      skills: uniqueSkills(matches),
      cleanedMessage: cleanedMessage.replace(/\s+/g, ' ').trim(),
      disabledSkillNames: Array.from(disabledSkillNames),
    };
  }

  private load(): void {
    if (!fs.existsSync(this.skillsRoot)) {
      this.logger?.info('未发现项目 skills 目录，跳过加载', { skillsRoot: this.skillsRoot });
      return;
    }

    for (const entry of fs.readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const filePath = path.join(this.skillsRoot, entry.name, 'SKILL.md');
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const skill = parseSkillMetadata(filePath);
        this.skills.set(skill.name, skill);
      } catch (error) {
        this.logger?.warn('加载 skill 失败，已跳过', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.loadState();
    this.logger?.info('项目 skills 加载完成', {
      skillsRoot: this.skillsRoot,
      count: this.skills.size,
      skills: Array.from(this.skills.keys()),
      enabledSkills: Array.from(this.enabledSkillNames),
    });
  }

  private loadState(): void {
    const savedNames = this.readState();
    this.enabledSkillNames.clear();

    if (savedNames === null) {
      for (const name of this.skills.keys()) {
        this.enabledSkillNames.add(name);
      }
      this.saveState();
      return;
    }

    for (const name of savedNames) {
      if (this.skills.has(name)) {
        this.enabledSkillNames.add(name);
      }
    }

    this.saveState();
  }

  private readState(): string[] | null {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as { enabledSkills?: unknown } | string[];
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }

      if (!Array.isArray(parsed.enabledSkills)) {
        return [];
      }

      return parsed.enabledSkills.filter((item): item is string => typeof item === 'string');
    } catch {
      return null;
    }
  }

  private saveState(): void {
    fs.writeFileSync(this.statePath, JSON.stringify({
      enabledSkills: Array.from(this.enabledSkillNames).sort(),
    }, null, 2), 'utf8');
  }

  private hydrateSkill(metadata: SkillMetadata | undefined): SkillDefinition | undefined {
    if (!metadata) {
      return undefined;
    }

    return {
      ...metadata,
      instructions: loadSkillInstructions(metadata.filePath),
    };
  }
}

function parseSkillMetadata(filePath: string): SkillMetadata {
  const raw = readFrontmatterBlock(filePath);
  const frontmatter = YAML.parse(raw) as Record<string, unknown> | null;
  const name = typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : '';
  const allowedTools = parseAllowedTools(frontmatter?.['allowed-tools']);

  validateSkillFrontmatter(name, description);

  return {
    name,
    description,
    allowedTools,
    directory: path.dirname(filePath),
    filePath,
  };
}

function loadSkillInstructions(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md 缺少 YAML frontmatter');
  }

  const frontmatter = YAML.parse(match[1]) as Record<string, unknown> | null;
  const instructions = match[2].trim();
  const name = typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : '';

  validateSkillFrontmatter(name, description);
  if (!instructions) {
    throw new Error('skill instructions 不能为空');
  }

  return instructions;
}

function validateSkillFrontmatter(name: string, description: string): void {
  if (!name) {
    throw new Error('frontmatter 缺少 name');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`skill name 不合法: ${name}`);
  }
  if (!description) {
    throw new Error('frontmatter 缺少 description');
  }
}

function readFrontmatterBlock(filePath: string): string {
  const handle = fs.openSync(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(1024);
    let content = '';

    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }

      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      content = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
      const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
      if (match) {
        return match[1];
      }
    }

    throw new Error('SKILL.md 缺少 YAML frontmatter');
  } finally {
    fs.closeSync(handle);
  }
}

function parseAllowedTools(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/\s+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function uniqueSkills(skills: SkillDefinition[]): SkillDefinition[] {
  const deduped = new Map<string, SkillDefinition>();
  for (const skill of skills) {
    deduped.set(skill.name, skill);
  }
  return Array.from(deduped.values());
}

function buildNaturalLanguageSkillPatterns(name: string): RegExp[] {
  const escapedName = escapeRegex(name);
  return [
    new RegExp(`(^|[\\s，。,:：])(?:请\\s*)?(?:用|使用|通过|按)\\s*${escapedName}(?=$|[\\s，。,:：])`, 'i'),
  ];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
