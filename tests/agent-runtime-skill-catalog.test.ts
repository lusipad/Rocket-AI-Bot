import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectSkillCatalog } from '../src/agent-runtime/index.ts';
import { SkillRegistry } from '../src/skills/registry.ts';

test('ProjectSkillCatalog 应只在 manifest discovery 时暴露 skill 描述', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'ado-lookup', '查询 Azure DevOps', 'azure_devops_server_rest', '完整 ADO 查询说明');

  const catalog = new ProjectSkillCatalog(new SkillRegistry(skillsRoot, undefined, statePath));
  const [manifest] = catalog.listManifests();

  assert.deepEqual(manifest, {
    name: 'ado-lookup',
    description: '查询 Azure DevOps',
    allowedTools: ['azure_devops_server_rest'],
    enabled: true,
    filePath: path.join(skillsRoot, 'ado-lookup', 'SKILL.md'),
  });
  assert.equal('instructions' in manifest, false);
  assert.deepEqual(catalog.getManifest('ado-lookup'), manifest);

  fs.rmSync(root, { recursive: true, force: true });
});

test('ProjectSkillCatalog 应按需加载完整 skill instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'code-lookup', '查询代码', 'search_code read_file', '完整代码查询说明');

  const catalog = new ProjectSkillCatalog(new SkillRegistry(skillsRoot, undefined, statePath));
  const detail = catalog.load('code-lookup');

  assert.equal(detail?.name, 'code-lookup');
  assert.equal(detail?.instructions, '完整代码查询说明');
  assert.equal(detail?.directory, path.join(skillsRoot, 'code-lookup'));
  assert.equal(catalog.load('missing'), undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

test('ProjectSkillCatalog 应支持显式 skill 匹配并返回清理后的输入', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'pr-review', '审查 PR', 'azure_devops_server_rest', '完整 PR 审查说明');

  const registry = new SkillRegistry(skillsRoot, undefined, statePath);
  const catalog = new ProjectSkillCatalog(registry);
  const match = catalog.matchExplicit('请用 $pr-review 看下这个 PR');

  assert.equal(match.cleanedInput, '请用 看下这个 PR');
  assert.deepEqual(match.disabledSkillNames, []);
  assert.equal(match.skills.length, 1);
  assert.equal(match.skills[0].name, 'pr-review');
  assert.equal(match.skills[0].instructions, '完整 PR 审查说明');

  fs.rmSync(root, { recursive: true, force: true });
});

function writeSkill(skillsRoot: string, name: string, description: string, allowedTools: string, instructions: string): void {
  const dir = path.join(skillsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      `allowed-tools: ${allowedTools}`,
      '---',
      instructions,
      '',
    ].join('\n'),
    'utf8',
  );
}
