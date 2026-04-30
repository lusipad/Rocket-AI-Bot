import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRuntime, ProjectSkillCatalog, SkillRuntime } from '../src/agent-runtime/index.ts';
import type { OrchestratorTrace } from '../src/agent/orchestrator.ts';
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

test('SkillRuntime 应路由启用的显式 skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'ado-lookup', '查询 ADO', 'azure_devops_server_rest', '完整 ADO 说明');

  const runtime = new SkillRuntime(
    new ProjectSkillCatalog(new SkillRegistry(skillsRoot, undefined, statePath)),
  );
  const route = runtime.route({ input: '$ado-lookup 查 PR 123' });

  assert.equal(route.kind, 'skill');
  assert.equal(route.cleanedInput, '查 PR 123');
  assert.deepEqual(route.disabledSkillNames, []);
  assert.equal(route.skills.length, 1);
  assert.equal(route.skills[0].name, 'ado-lookup');
  assert.equal(route.skills[0].instructions, '完整 ADO 说明');

  fs.rmSync(root, { recursive: true, force: true });
});

test('SkillRuntime 应报告被禁用的显式 skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'code-lookup', '查询代码', 'search_code read_file', '完整代码说明');

  const registry = new SkillRegistry(skillsRoot, undefined, statePath);
  registry.setEnabled('code-lookup', false);
  const runtime = new SkillRuntime(new ProjectSkillCatalog(registry));
  const route = runtime.route({ input: '$code-lookup 查入口' });

  assert.equal(route.kind, 'disabled_skill');
  assert.equal(route.cleanedInput, '查入口');
  assert.deepEqual(route.disabledSkillNames, ['code-lookup']);
  assert.deepEqual(route.skills, []);

  fs.rmSync(root, { recursive: true, force: true });
});

test('SkillRuntime 没有显式 skill 时应回退', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'code-lookup', '查询代码', 'search_code read_file', '完整代码说明');

  const runtime = new SkillRuntime(
    new ProjectSkillCatalog(new SkillRegistry(skillsRoot, undefined, statePath)),
  );
  const route = runtime.route({ input: '查入口' });

  assert.equal(route.kind, 'fallback');
  assert.equal(route.cleanedInput, '查入口');
  assert.deepEqual(route.disabledSkillNames, []);
  assert.deepEqual(route.skills, []);

  fs.rmSync(root, { recursive: true, force: true });
});

test('AgentRuntime 应通过真实 SkillRegistry 接线优先处理显式 skill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agent-skill-'));
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  writeSkill(skillsRoot, 'code-lookup', '查询代码', 'search_code read_file', '完整代码说明');

  let orchestratorCalled = false;
  let capabilityCalled = false;
  const skillRuntime = new SkillRuntime(
    new ProjectSkillCatalog(new SkillRegistry(skillsRoot, undefined, statePath)),
  );
  const agentRuntime = new AgentRuntime({
    previewModelMode() {
      return { mode: 'normal', model: 'gpt-5.5' };
    },
    async handle(
      _userId: string,
      _username: string,
      _message: string,
      _conversation: unknown[],
      _images: string[],
      _requestContext: unknown,
      options: { trace?: OrchestratorTrace },
    ) {
      orchestratorCalled = true;
      if (options.trace) {
        options.trace.status = 'success';
        options.trace.finishReason = 'reply';
        options.trace.rounds = 1;
        options.trace.activeSkills = ['code-lookup'];
        options.trace.skillSources = { 'code-lookup': 'explicit' };
        options.trace.usedTools = ['read_file'];
      }
      return 'skill reply';
    },
  } as never, {
    getModel() {
      return 'gpt-5.5';
    },
  } as never, [{
    id: 'catch-all',
    description: 'catch-all capability',
    priority: 100,
    canHandle: () => true,
    async handle(request) {
      capabilityCalled = true;
      return {
        requestId: request.id,
        status: 'success',
        text: 'capability reply',
        messages: [{ type: 'text', text: 'capability reply' }],
        model: 'none',
        trace: {
          activeSkills: [],
          skillSources: {},
          usedTools: [],
          rounds: 0,
          status: 'success',
        },
      };
    },
  }], { skillRuntime });

  const response = await agentRuntime.handle({
    id: 'req-real-skill-runtime',
    input: '$code-lookup 查入口',
    actor: { id: 'u1', username: 'alice', kind: 'human' },
    channel: { kind: 'rocketchat' },
  });

  assert.equal(orchestratorCalled, true);
  assert.equal(capabilityCalled, false);
  assert.equal(response.text, 'skill reply');
  assert.deepEqual(response.trace.activeSkills, ['code-lookup']);
  assert.deepEqual(response.trace.usedTools, ['read_file']);

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
