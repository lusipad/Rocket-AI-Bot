import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-core/registry.ts';

test('AgentRegistry 在没有配置文件时应回退到默认 AgentDefinition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agents-'));
  const registry = new AgentRegistry({
    rootDir: path.join(root, 'agents'),
    defaultModel: 'gpt-5.5',
    defaultDeepModel: 'gpt-5.5-pro',
  });

  const agents = registry.list();
  assert.equal(agents.length, 1);
  assert.equal(registry.getDefault().id, 'rocketbot-default');
  assert.equal(registry.resolveForChannel('rocketchat').id, 'rocketbot-default');
  assert.equal(agents[0].model, 'gpt-5.5');

  fs.rmSync(root, { recursive: true, force: true });
});

test('AgentRegistry 应从磁盘加载启用的 AgentDefinition 并选择第一个作为默认 Agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agents-'));
  const agentsRoot = path.join(root, 'agents');
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(agentsRoot, 'devops.json'),
    JSON.stringify({
      id: 'devops-agent',
      name: 'DevOps Agent',
      description: 'Handles DevOps tasks',
      model: 'gpt-5.5',
      deepModel: 'gpt-5.5-pro',
      channels: ['rocketchat'],
      instructions: '只处理 DevOps 场景。',
      skillPolicy: {
        mode: 'allowlist',
        allowedSkills: ['ado-lookup'],
      },
      contextPolicyRef: 'default',
      enabled: true,
    }),
    'utf8',
  );

  const registry = new AgentRegistry({
    rootDir: agentsRoot,
    defaultModel: 'fallback-model',
  });

  assert.deepEqual(registry.list().map((agent) => agent.id), ['devops-agent']);
  assert.equal(registry.getDefault().id, 'devops-agent');
  assert.equal(registry.resolveForChannel('scheduler').id, 'devops-agent');

  fs.rmSync(root, { recursive: true, force: true });
});

test('AgentRegistry 遇到非法 AgentDefinition 应拒绝启动', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-agents-'));
  const agentsRoot = path.join(root, 'agents');
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(agentsRoot, 'broken.json'),
    JSON.stringify({
      id: 'broken agent',
      name: '',
      model: 'gpt-5.5',
      channels: [],
      instructions: '',
      skillPolicy: {
        mode: 'allowlist',
      },
      contextPolicyRef: 'default',
      enabled: true,
    }),
    'utf8',
  );

  assert.throws(
    () => new AgentRegistry({
      rootDir: agentsRoot,
      defaultModel: 'gpt-5.5',
    }),
    /Invalid agent definition/,
  );

  fs.rmSync(root, { recursive: true, force: true });
});
