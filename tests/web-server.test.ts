import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillRegistry } from '../src/skills/registry.ts';
import { createWebServer } from '../src/web/server.ts';
import { Scheduler, type TaskRunner } from '../src/scheduler/index.ts';
import { TaskPersistence } from '../src/scheduler/persistence.ts';
import { RequestLogStore } from '../src/observability/request-log-store.ts';
import { DiscussionSummaryAdminService } from '../src/discussion/admin-service.ts';
import { DiscussionSummaryStore } from '../src/discussion/summary-store.ts';
import { ContextPolicyStore } from '../src/context/policy-store.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createScheduler(root: string, runner?: TaskRunner) {
  const persistence = new TaskPersistence(
    path.join(root, 'tasks.json'),
    path.join(root, 'history'),
  );

  return new Scheduler(
    persistence,
    runner ?? (async (task) => ({ success: true, output: `ran:${task.name}` })),
    createLogger() as never,
  );
}

function createSkillRegistry(root: string): SkillRegistry {
  const skillsRoot = path.join(root, 'skills');
  const statePath = path.join(root, 'skill-state.json');
  const codeLookupDir = path.join(skillsRoot, 'code-lookup');
  const adoLookupDir = path.join(skillsRoot, 'ado-lookup');
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

  return new SkillRegistry(skillsRoot, undefined, statePath);
}

function createGitSkillRepo(root: string, relativeDir = '.'): string {
  const repoDir = path.join(root, 'skill-repo');
  const skillDir = relativeDir === '.' ? repoDir : path.join(repoDir, relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\n'
    + 'name: external-skill\n'
    + 'description: 外部安装 skill\n'
    + 'allowed-tools: search_code read_file\n'
    + '---\n'
    + '- 外部安装\n',
    'utf8',
  );

  const initResult = spawnSync('git', ['init', '--quiet', repoDir], { encoding: 'utf8' });
  if (initResult.status !== 0) {
    throw new Error(initResult.stderr || initResult.stdout || 'git init 失败');
  }

  spawnSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'], { encoding: 'utf8' });
  const addResult = spawnSync('git', ['-C', repoDir, 'add', '.'], { encoding: 'utf8' });
  if (addResult.status !== 0) {
    throw new Error(addResult.stderr || addResult.stdout || 'git add 失败');
  }

  const commitResult = spawnSync('git', ['-C', repoDir, 'commit', '--quiet', '-m', 'init'], { encoding: 'utf8' });
  if (commitResult.status !== 0) {
    throw new Error(commitResult.stderr || commitResult.stdout || 'git commit 失败');
  }

  return repoDir;
}

function createDiscussionAdminService(root: string): DiscussionSummaryAdminService {
  const summaryStore = new DiscussionSummaryStore(path.join(root, 'summaries'));
  const policyStore = new ContextPolicyStore(path.join(root, 'context-policy.json'));

  return new DiscussionSummaryAdminService(
    summaryStore,
    policyStore,
    {
      async getRecentMessages() {
        return [
          { role: 'user', username: 'alice', text: '先做 A', images: [] },
          { role: 'user', username: 'bob', text: '补回滚预案', images: [] },
        ];
      },
    } as never,
    {
      async chat() {
        return {
          choices: [
            {
              message: {
                content: '结论：先做 A，并补回滚预案。',
              },
            },
          ],
        };
      },
    } as never,
    createLogger() as never,
  );
}

async function withServer<T>(
  scheduler: Scheduler,
  skillRegistry: SkillRegistry,
  requestLogStore: RequestLogStore,
  discussionAdminService: DiscussionSummaryAdminService,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = createWebServer({
    logger: createLogger() as never,
    scheduler,
    llm: {
      circuitBreaker: { stateName: 'CLOSED' },
      getModel: () => 'gpt-4',
      getDeepModel: () => 'gpt-4-pro',
      getApiMode: () => 'chat_completions',
      probeApiModes: async () => ({
        current: 'chat_completions',
        recommended: 'chat_completions',
        results: [
          {
            mode: 'chat_completions',
            ok: true,
            durationMs: 12,
            model: 'gpt-4',
            reply: 'pong',
          },
          {
            mode: 'responses',
            ok: false,
            durationMs: 8,
            error: 'unsupported',
          },
        ],
      }),
    } as never,
    bot: {
      isConnected: false,
    } as never,
    skillRegistry,
    requestLogStore,
    discussionAdminService,
    webSecret: 'secret-token',
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法获取监听端口');
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    scheduler.stopAll();
  }
}

test('健康检查接口不应要求鉴权', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, 'ok');
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('管理端根路径与旧路径别名应重定向到 /admin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const rootResponse = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(rootResponse.status, 302);
    assert.equal(rootResponse.headers.get('location'), '/admin');

    const skillsResponse = await fetch(`${baseUrl}/skills`, { redirect: 'manual' });
    assert.equal(skillsResponse.status, 302);
    assert.equal(skillsResponse.headers.get('location'), '/admin/skills');
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('状态接口应支持探测 LLM API 兼容模式', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status/llm-api-mode-probe`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.current, 'chat_completions');
    assert.equal(body.recommended, 'chat_completions');
    assert.deepEqual(body.results.map((result: { mode: string; ok: boolean }) => [result.mode, result.ok]), [
      ['chat_completions', true],
      ['responses', false],
    ]);
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('任务局部更新时应保留已有 cron 和 room', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));
  scheduler.addTask({
    name: 'daily-report',
    prompt: '生成日报并发送到频道',
    cron: '0 9 * * 1-5',
    room: 'general',
    enabled: true,
  });

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/daily-report`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(scheduler.listTasks(), [{
    name: 'daily-report',
    prompt: '生成日报并发送到频道',
    cron: '0 9 * * 1-5',
    room: 'general',
    enabled: false,
  }]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('创建任务时应接受独立 prompt 字段', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'daily-news',
        prompt: '联网搜索今天的重要 AI 新闻并整理为三条摘要',
        cron: '50 4 * * *',
        room: 'GENERAL',
        enabled: true,
      }),
    });

    assert.equal(response.status, 201);
  });

  assert.deepEqual(scheduler.listTasks(), [{
    name: 'daily-news',
    prompt: '联网搜索今天的重要 AI 新闻并整理为三条摘要',
    cron: '50 4 * * *',
    room: 'GENERAL',
    enabled: true,
  }]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('任务模板接口应返回内置 DevTools 模板', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/templates`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(response.status, 200);

    const templates = await response.json();
    assert.deepEqual(templates.map((template: { id: string }) => template.id), [
      'pr-status-summary',
      'pipeline-health-check',
      'work-item-risk-digest',
    ]);
    assert.equal(templates[0].category, 'azure-devops');
    assert.match(templates[0].defaultPrompt, /main 分支/);
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('应支持从任务模板创建调度任务', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/from-template`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: 'pipeline-health-check',
        name: 'main-pipeline-health',
        room: 'DEVTOOLS',
        cron: '15 11 * * 1-5',
        enabled: false,
      }),
    });
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.task.templateId, 'pipeline-health-check');
  });

  const [task] = scheduler.listTasks();
  assert.equal(task.name, 'main-pipeline-health');
  assert.equal(task.templateId, 'pipeline-health-check');
  assert.match(task.prompt ?? '', /pipeline\/build 状态/);
  assert.equal(task.cron, '15 11 * * 1-5');
  assert.equal(task.room, 'DEVTOOLS');
  assert.equal(task.enabled, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test('从未知任务模板创建任务时应返回 404', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/from-template`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: 'missing-template',
        name: 'bad-task',
      }),
    });
    assert.equal(response.status, 404);
  });

  assert.deepEqual(scheduler.listTasks(), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('手动执行任务应返回并记录请求追踪信息', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root, async (task) => ({
    success: true,
    output: `ran:${task.name}`,
    requestId: 'req-task-run-1',
    requestType: 'pipeline_monitor',
    model: 'gpt-5.4',
    usedTools: ['azure_devops_server_rest'],
    sources: [{
      type: 'azure_devops',
      title: 'Build 42',
      ref: 'build:42',
      url: 'http://localhost:8081/build/42',
    }],
  }));
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));
  scheduler.addTask({
    name: 'pipeline-health',
    templateId: 'pipeline-health-check',
    prompt: '检查 pipeline',
    cron: '15 11 * * 1-5',
    room: 'DEVTOOLS',
    enabled: false,
  });

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/pipeline-health/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.requestId, 'req-task-run-1');
    assert.equal(body.requestType, 'pipeline_monitor');
    assert.deepEqual(body.usedTools, ['azure_devops_server_rest']);
  });

  const history = scheduler.getHistory('pipeline-health', 1);
  assert.equal(history.length, 1);
  assert.deepEqual(history, [{
    taskName: 'pipeline-health',
    timestamp: history[0].timestamp,
    success: true,
    output: 'ran:pipeline-health',
    requestId: 'req-task-run-1',
    requestType: 'pipeline_monitor',
    model: 'gpt-5.4',
    usedTools: ['azure_devops_server_rest'],
    sources: [{
      type: 'azure_devops',
      title: 'Build 42',
      ref: 'build:42',
      url: 'http://localhost:8081/build/42',
    }],
  }]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('skills 接口应返回已装载列表并支持切换启用状态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/skills`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(listResponse.status, 200);

    const list = await listResponse.json();
    assert.equal(list.length, 2);
    assert.equal(list[0].enabled, true);

    const updateResponse = await fetch(`${baseUrl}/api/skills/code-lookup`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(updateResponse.status, 200);

    const updated = await updateResponse.json();
    assert.equal(updated.enabled, false);

    const statusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(statusResponse.status, 200);

    const status = await statusResponse.json();
    assert.deepEqual(status.skills, {
      installed: 2,
      enabled: 1,
    });
    assert.deepEqual(status.requests, {
      total: 0,
      success: 0,
      error: 0,
      rejected: 0,
      byKind: {
        chat: 0,
        scheduler: 0,
      },
      byRequestType: {},
      sourceCoverage: {
        withSources: 0,
        sourceRate: 0,
      },
    });
  });

  assert.equal(skillRegistry.isEnabled('code-lookup'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills reload 接口应重新扫描新安装的 skill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const newSkillDir = path.join(root, 'skills', 'artifact-writer');
    fs.mkdirSync(newSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(newSkillDir, 'SKILL.md'),
      '---\n'
      + 'name: artifact-writer\n'
      + 'description: 生成制品\n'
      + 'allowed-tools: search_code read_file azure_devops\n'
      + '---\n'
      + '- 生成制品\n',
      'utf8',
    );

    const reloadResponse = await fetch(`${baseUrl}/api/skills/reload`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(reloadResponse.status, 200);

    const body = await reloadResponse.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.skills.map((skill: { name: string }) => skill.name), [
      'ado-lookup',
      'artifact-writer',
      'code-lookup',
    ]);

    const listResponse = await fetch(`${baseUrl}/api/skills`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.length, 3);
    assert.equal(list[1].enabled, false);
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('skills 详情接口应返回指定 skill 的完整信息', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/skills/code-lookup`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(response.status, 200);

    const detail = await response.json();
    assert.equal(detail.name, 'code-lookup');
    assert.equal(detail.enabled, true);
    assert.match(detail.directory, /code-lookup$/);
    assert.match(detail.instructions, /查代码/);
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('skills 卸载接口应移除项目 skill 并返回最新列表', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/skills/ado-lookup`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.skills.map((skill: { name: string }) => skill.name), ['code-lookup']);

    const detailResponse = await fetch(`${baseUrl}/api/skills/ado-lookup`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(detailResponse.status, 404);
  });

  assert.equal(fs.existsSync(path.join(root, 'skills', 'ado-lookup')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('skills 安装接口应从 git 仓库安装 skill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));
  const repoDir = createGitSkillRepo(root, 'packages/external-skill');

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/skills/install`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: repoDir,
        subdir: 'packages/external-skill',
      }),
    });
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.installed.name, 'external-skill');
    assert.deepEqual(body.skills.map((skill: { name: string }) => skill.name), [
      'ado-lookup',
      'code-lookup',
      'external-skill',
    ]);
  });

  assert.equal(fs.existsSync(path.join(root, 'skills', 'external-skill', 'SKILL.md')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('requests 接口应返回请求记录列表、详情和摘要', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));

  requestLogStore.record({
    requestId: 'req-chat-1',
    kind: 'chat',
    status: 'success',
    finishReason: 'reply',
    model: 'gpt-4',
    startedAt: '2026-04-26T08:00:00.000Z',
    finishedAt: '2026-04-26T08:00:01.200Z',
    durationMs: 1200,
    userId: 'user-1',
    username: 'alice',
    roomId: 'GENERAL',
    roomType: 'c',
    prompt: '帮我总结',
    reply: '总结好了',
    requestType: 'discussion',
    activeSkills: ['artifact-writer'],
    skillSources: { 'artifact-writer': 'explicit' },
    usedTools: ['room_history'],
    rounds: 2,
    sources: [{ type: 'chat', title: 'GENERAL', ref: 'room:GENERAL' }],
  });
  requestLogStore.record({
    requestId: 'req-code-1',
    kind: 'chat',
    status: 'success',
    finishReason: 'reply',
    model: 'gpt-4',
    startedAt: '2026-04-26T08:30:00.000Z',
    finishedAt: '2026-04-26T08:30:01.000Z',
    durationMs: 1000,
    username: 'bob',
    roomId: 'GENERAL',
    prompt: '看下 src/index.ts',
    reply: '入口在 src/index.ts',
    requestType: 'code_query',
    activeSkills: ['code-lookup'],
    skillSources: { 'code-lookup': 'explicit' },
    usedTools: ['read_file'],
    rounds: 1,
    sources: [{ type: 'file', title: 'src/index.ts', ref: 'src/index.ts:1' }],
  });
  requestLogStore.record({
    requestId: 'req-scheduler-1',
    kind: 'scheduler',
    status: 'error',
    finishReason: 'circuit_breaker',
    model: 'gpt-4',
    startedAt: '2026-04-26T09:00:00.000Z',
    finishedAt: '2026-04-26T09:00:05.000Z',
    durationMs: 5000,
    username: '系统',
    roomId: 'general',
    taskName: 'daily-news',
    taskTemplateId: 'work-item-risk-digest',
    prompt: '搜索新闻',
    requestType: 'scheduler',
    error: 'AI 服务暂时不可用',
    activeSkills: ['scheduled-report'],
    skillSources: { 'scheduled-report': 'system' },
    usedTools: [],
    rounds: 1,
  });

  await withServer(scheduler, skillRegistry, requestLogStore, createDiscussionAdminService(root), async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/requests?kind=chat&username=alice`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].requestId, 'req-chat-1');
    assert.equal(list[0].requestType, 'discussion');
    assert.deepEqual(list[0].sources, [{ type: 'chat', title: 'GENERAL', ref: 'room:GENERAL' }]);

    const typeFilterResponse = await fetch(`${baseUrl}/api/requests?requestType=discussion`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(typeFilterResponse.status, 200);
    const typeFiltered = await typeFilterResponse.json();
    assert.deepEqual(typeFiltered.map((entry: { requestId: string }) => entry.requestId), ['req-chat-1']);

    const detailResponse = await fetch(`${baseUrl}/api/requests/req-scheduler-1`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.taskName, 'daily-news');
    assert.equal(detail.taskTemplateId, 'work-item-risk-digest');
    assert.equal(detail.finishReason, 'circuit_breaker');

    const summaryResponse = await fetch(`${baseUrl}/api/requests/summary/recent`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.deepEqual(summary, {
      total: 3,
      success: 2,
      error: 1,
      rejected: 0,
      byKind: {
        chat: 2,
        scheduler: 1,
      },
      byRequestType: {
        code_query: 1,
        discussion: 1,
        scheduler: 1,
      },
      sourceCoverage: {
        withSources: 2,
        sourceRate: 0.667,
      },
      lastFinishedAt: '2026-04-26T09:00:05.000Z',
    });

    const metricsResponse = await fetch(`${baseUrl}/api/requests/metrics/devtools`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(metricsResponse.status, 200);
    const metrics = await metricsResponse.json();
    assert.deepEqual(metrics, {
      total: 3,
      devToolsTotal: 1,
      devToolsRate: 0.333,
      byRequestType: {
        code_query: 1,
      },
      byTool: {
        read_file: 1,
      },
      sourceCoverage: {
        withSources: 1,
        sourceRate: 1,
      },
      lastFinishedAt: '2026-04-26T09:00:05.000Z',
    });
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('context 接口应返回并更新上下文策略，同时支持摘要清空与重建', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-context-'));
  const scheduler = createScheduler(root);
  const skillRegistry = createSkillRegistry(root);
  const requestLogStore = new RequestLogStore(path.join(root, 'requests'));
  const discussionAdminService = createDiscussionAdminService(root);

  const store = new DiscussionSummaryStore(path.join(root, 'summaries'));
  store.save({
    roomId: 'GENERAL',
    roomType: 'c',
    summary: '旧摘要',
    updatedAt: '2026-04-26T10:00:00.000Z',
    sourceMessageCount: 3,
  });

  await withServer(scheduler, skillRegistry, requestLogStore, discussionAdminService, async (baseUrl) => {
    const policyResponse = await fetch(`${baseUrl}/api/context/policy`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(policyResponse.status, 200);
    const policy = await policyResponse.json();
    assert.equal(policy.group.recentMessageCount, 40);
    assert.equal(policy.publicChannel.lookbackMinutes, 45);

    const updateResponse = await fetch(`${baseUrl}/api/context/policy`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        group: {
          recentMessageCount: 24,
          summaryEnabled: false,
        },
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json();
    assert.equal(updated.group.recentMessageCount, 24);
    assert.equal(updated.group.summaryEnabled, false);
    assert.equal(updated.group.discussionRecentMessageCount, 80);
    assert.equal(updated.publicChannel.lookbackMinutes, 45);

    const summariesResponse = await fetch(`${baseUrl}/api/context/summaries`, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
    });
    assert.equal(summariesResponse.status, 200);
    const summaries = await summariesResponse.json();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].summary, '旧摘要');

    const rebuildResponse = await fetch(`${baseUrl}/api/context/summaries/rebuild`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roomId: 'GENERAL',
        roomType: 'c',
      }),
    });
    assert.equal(rebuildResponse.status, 200);
    const rebuild = await rebuildResponse.json();
    assert.equal(rebuild.ok, true);
    assert.equal(rebuild.entry.summary, '结论：先做 A，并补回滚预案。');
    assert.equal(rebuild.recentMessageCount, 2);

    const clearResponse = await fetch(`${baseUrl}/api/context/summaries/clear`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roomId: 'GENERAL',
      }),
    });
    assert.equal(clearResponse.status, 200);
    const cleared = await clearResponse.json();
    assert.deepEqual(cleared, {
      ok: true,
      deleted: true,
    });
  });

  fs.rmSync(root, { recursive: true, force: true });
});
