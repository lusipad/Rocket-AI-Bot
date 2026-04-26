import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillRegistry } from '../src/skills/registry.ts';

test('SkillRegistry 应加载 SKILL.md 并解析 allowed-tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-registry-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const skillDir = path.join(root, 'artifact-writer');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\n'
    + 'name: artifact-writer\n'
    + 'description: 生成制品\n'
    + 'allowed-tools: search_code read_file azure_devops\n'
    + '---\n'
    + '# Artifact Writer\n'
    + '- 输出固定结构\n',
    'utf8',
  );

  const registry = new SkillRegistry(root, undefined, statePath);
  const skill = registry.get('artifact-writer');

  assert.ok(skill);
  assert.equal(skill?.description, '生成制品');
  assert.deepEqual(skill?.allowedTools, ['search_code', 'read_file', 'azure_devops']);
  assert.match(skill?.instructions ?? '', /Artifact Writer/);
});

test('SkillRegistry 列表查询不应预加载 skill 正文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-lazy-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const skillPath = path.join(root, 'code-lookup', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '# Code Lookup\n'
    + '- 查代码\n',
    'utf8',
  );

  const originalReadFileSync = fs.readFileSync;
  let skillBodyReads = 0;
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path.resolve(String(filePath)) === skillPath) {
      skillBodyReads += 1;
    }
    return originalReadFileSync(filePath, ...(args as [BufferEncoding]));
  }) as typeof fs.readFileSync;

  try {
    const registry = new SkillRegistry(root, undefined, statePath);

    assert.deepEqual(registry.list().map((skill) => skill.name), ['code-lookup']);
    assert.deepEqual(registry.listInstalled().map((skill) => skill.name), ['code-lookup']);
    assert.equal(skillBodyReads, 0);

    assert.match(registry.get('code-lookup')?.instructions ?? '', /Code Lookup/);
    assert.equal(skillBodyReads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('SkillRegistry 应识别显式 skill token 并清理消息文本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-match-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const skillDir = path.join(root, 'code-lookup');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 查代码\n',
    'utf8',
  );

  const registry = new SkillRegistry(root, undefined, statePath);
  const matched = registry.findExplicitSkills('请 $code-lookup 看下 src/index.ts');

  assert.deepEqual(matched.skills.map((skill) => skill.name), ['code-lookup']);
  assert.equal(matched.cleanedMessage, '请 看下 src/index.ts');
});

test('SkillRegistry 应识别自然语言显式 skill 并清理消息文本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-natural-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const skillDir = path.join(root, 'code-lookup');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 查代码\n',
    'utf8',
  );

  const registry = new SkillRegistry(root, undefined, statePath);
  const matched = registry.findNaturalLanguageSkills('请用 code-lookup 看下 src/index.ts');

  assert.deepEqual(matched.skills.map((skill) => skill.name), ['code-lookup']);
  assert.equal(matched.cleanedMessage, '看下 src/index.ts');
});

test('SkillRegistry 应持久化启用状态，并让后续新安装 skill 默认禁用', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-state-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const firstSkillDir = path.join(root, 'code-lookup');
  fs.mkdirSync(firstSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(firstSkillDir, 'SKILL.md'),
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 查代码\n',
    'utf8',
  );

  const firstRegistry = new SkillRegistry(root, undefined, statePath);
  assert.equal(firstRegistry.isEnabled('code-lookup'), true);
  firstRegistry.setEnabled('code-lookup', false);

  const secondSkillDir = path.join(root, 'ado-lookup');
  fs.mkdirSync(secondSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(secondSkillDir, 'SKILL.md'),
    '---\n'
    + 'name: ado-lookup\n'
    + 'description: 查 ADO\n'
    + 'allowed-tools: azure_devops\n'
    + '---\n'
    + '- 查 ADO\n',
    'utf8',
  );

  const nextRegistry = new SkillRegistry(root, undefined, statePath);
  assert.equal(nextRegistry.isEnabled('code-lookup'), false);
  assert.equal(nextRegistry.isEnabled('ado-lookup'), false);
});

test('SkillRegistry.reload 应重新扫描新安装的 skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-reload-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const firstSkillDir = path.join(root, 'code-lookup');
  fs.mkdirSync(firstSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(firstSkillDir, 'SKILL.md'),
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 查代码\n',
    'utf8',
  );

  const registry = new SkillRegistry(root, undefined, statePath);
  assert.equal(registry.listInstalled().length, 1);

  const secondSkillDir = path.join(root, 'ado-lookup');
  fs.mkdirSync(secondSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(secondSkillDir, 'SKILL.md'),
    '---\n'
    + 'name: ado-lookup\n'
    + 'description: 查 ADO\n'
    + 'allowed-tools: azure_devops\n'
    + '---\n'
    + '- 查 ADO\n',
    'utf8',
  );

  const reloaded = registry.reload();
  assert.deepEqual(reloaded.map((skill) => skill.name), ['ado-lookup', 'code-lookup']);
  assert.equal(registry.isEnabled('ado-lookup'), false);
});

test('SkillRegistry.getInstalled 应返回 skill 详情', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-detail-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const skillDir = path.join(root, 'code-lookup');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '# Code Lookup\n'
    + '- 查代码\n',
    'utf8',
  );

  const registry = new SkillRegistry(root, undefined, statePath);
  const skill = registry.getInstalled('code-lookup');

  assert.ok(skill);
  assert.equal(skill?.name, 'code-lookup');
  assert.equal(skill?.enabled, true);
  assert.equal(skill?.directory, skillDir);
  assert.match(skill?.instructions ?? '', /Code Lookup/);
});

test('SkillRegistry.remove 应删除 skill 目录并清理状态', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-remove-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const codeLookupDir = path.join(root, 'code-lookup');
  const adoLookupDir = path.join(root, 'ado-lookup');
  fs.mkdirSync(codeLookupDir, { recursive: true });
  fs.mkdirSync(adoLookupDir, { recursive: true });
  fs.writeFileSync(
    path.join(codeLookupDir, 'SKILL.md'),
    '---\n'
    + 'name: code-lookup\n'
    + 'description: 查代码\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 查代码\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(adoLookupDir, 'SKILL.md'),
    '---\n'
    + 'name: ado-lookup\n'
    + 'description: 查 ADO\n'
    + 'allowed-tools: azure_devops\n'
    + '---\n'
    + '- 查 ADO\n',
    'utf8',
  );

  const registry = new SkillRegistry(root, undefined, statePath);
  registry.setEnabled('ado-lookup', false);

  const remaining = registry.remove('ado-lookup');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { enabledSkills: string[] };

  assert.equal(fs.existsSync(adoLookupDir), false);
  assert.deepEqual(remaining.map((skill) => skill.name), ['code-lookup']);
  assert.deepEqual(state.enabledSkills, ['code-lookup']);
});

test('SkillRegistry.installFromDirectory 应复制 skill 到项目目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-install-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-source-'));
  const sourceDir = path.join(sourceRoot, 'artifact-writer');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'SKILL.md'),
    '---\n'
    + 'name: artifact-writer\n'
    + 'description: 生成制品\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 生成制品\n',
    'utf8',
  );
  fs.writeFileSync(path.join(sourceDir, 'README.txt'), 'helper', 'utf8');
  fs.mkdirSync(path.join(sourceDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, '.git', 'config'), 'secret', 'utf8');
  fs.mkdirSync(path.join(sourceDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'node_modules', 'ignored.js'), 'ignored', 'utf8');

  const registry = new SkillRegistry(root, undefined, statePath);
  const installed = registry.installFromDirectory(sourceDir);

  assert.equal(installed.name, 'artifact-writer');
  assert.equal(installed.directory, path.join(root, 'artifact-writer'));
  assert.equal(fs.existsSync(path.join(root, 'artifact-writer', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'artifact-writer', 'README.txt')), true);
  assert.equal(fs.existsSync(path.join(root, 'artifact-writer', '.git')), false);
  assert.equal(fs.existsSync(path.join(root, 'artifact-writer', 'node_modules')), false);
});
