import assert from 'node:assert/strict';
import test from 'node:test';
import { createAzureDevOpsServerRestTool } from '../src/tools/azure-devops-server-rest.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('azure_devops_server_rest 应调用 PowerShell wrapper 并解析 JSON 输出', async () => {
  let receivedCommand = '';
  let receivedArgs: string[] = [];
  let receivedEnv: NodeJS.ProcessEnv = {};
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    project: 'Demo',
    pat: 'secret',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async (command, args, options) => {
      receivedCommand = command;
      receivedArgs = args;
      receivedEnv = options.env;
      return {
        stdout: JSON.stringify({
          count: 1,
          value: [{ id: 'repo-1', name: 'web-app' }],
          Uri: 'http://ado/DefaultCollection/Demo/_apis/git/repositories?api-version=6.0',
        }),
        stderr: '',
      };
    },
  });

  const result = await tool.execute(
    {
      method: 'GET',
      area: 'git',
      resource: 'repositories',
      query: { '$top': 25 },
    },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.equal(receivedCommand, 'pwsh');
  assert.deepEqual(receivedArgs.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(receivedEnv.ROCKETBOT_ADO_COLLECTION_URL, 'http://ado/DefaultCollection');
  assert.equal(receivedEnv.ROCKETBOT_ADO_AUTH_MODE, 'pat');
  assert.equal(receivedEnv.ROCKETBOT_ADO_PAT, 'secret');
  assert.equal(receivedEnv.ROCKETBOT_ADO_DEFAULT_PROJECT, 'Demo');
  assert.equal(receivedEnv.ROCKETBOT_ADO_METHOD, 'GET');
  assert.equal(receivedEnv.ROCKETBOT_ADO_AREA, 'git');
  assert.equal(receivedEnv.ROCKETBOT_ADO_RESOURCE, 'repositories');
  assert.deepEqual(JSON.parse(receivedEnv.ROCKETBOT_ADO_QUERY_JSON ?? '{}'), { '$top': 25 });
  assert.match(JSON.stringify(result.data.result), /web-app/);
  assert.deepEqual(result.data.sources, [{
    type: 'azure_devops',
    title: 'GET git/repositories',
    ref: 'GET git/repositories',
    url: 'http://ado/DefaultCollection/Demo/_apis/git/repositories?api-version=6.0',
  }]);
});

test('azure_devops_server_rest 应阻止非读取 POST live 请求', async () => {
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  const result = await tool.execute(
    {
      method: 'POST',
      area: 'git',
      resource: 'repositories/web-app/pullrequests',
      body: { title: 'Create PR' },
    },
    createLogger() as never,
  );

  assert.equal(result.success, false);
  assert.match(String(result.data.error), /live 写操作已被 RocketBot 拦截/);
});

test('azure_devops_server_rest 应拒绝完整 URL resource', async () => {
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  const result = await tool.execute(
    {
      method: 'GET',
      resource: 'https://example.com/_apis/projects',
    },
    createLogger() as never,
  );

  assert.equal(result.success, false);
  assert.match(String(result.data.error), /不能是完整 URL/);
});

test('azure_devops_server_rest 应允许 WIQL 读取型 POST live 请求', async () => {
  let receivedEnv: NodeJS.ProcessEnv = {};
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    project: 'Demo',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async (_command, _args, options) => {
      receivedEnv = options.env;
      return {
        stdout: JSON.stringify({ workItems: [{ id: 123 }] }),
        stderr: '',
      };
    },
  });

  const result = await tool.execute(
    {
      method: 'POST',
      area: 'wit',
      resource: 'wiql',
      body: { query: 'SELECT [System.Id] FROM WorkItems' },
    },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.equal(receivedEnv.ROCKETBOT_ADO_METHOD, 'POST');
  assert.deepEqual(JSON.parse(receivedEnv.ROCKETBOT_ADO_BODY_JSON ?? '{}'), {
    query: 'SELECT [System.Id] FROM WorkItems',
  });
});

test('azure_devops_server_rest 应兼容 resource 中的 query string', async () => {
  let receivedEnv: NodeJS.ProcessEnv = {};
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    project: 'Demo',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async (_command, _args, options) => {
      receivedEnv = options.env;
      return {
        stdout: JSON.stringify({
          path: '/README.md',
          content: '# Introduction',
        }),
        stderr: '',
      };
    },
  });

  const result = await tool.execute(
    {
      method: 'GET',
      area: 'git',
      resource: 'repositories/test/items?path=/README.md&includeContent=true',
    },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.equal(receivedEnv.ROCKETBOT_ADO_RESOURCE, 'repositories/test/items');
  assert.deepEqual(JSON.parse(receivedEnv.ROCKETBOT_ADO_QUERY_JSON ?? '{}'), {
    path: '/README.md',
    includeContent: 'true',
  });
});

test('azure_devops_server_rest 应允许写操作 dryRun 预览但不设置 AllowWrite', async () => {
  let receivedArgs: string[] = [];
  let receivedEnv: NodeJS.ProcessEnv = {};
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async (_command, args, options) => {
      receivedArgs = args;
      receivedEnv = options.env;
      return {
        stdout: JSON.stringify({
          Method: 'PATCH',
          Uri: 'http://ado/DefaultCollection/_apis/wit/workitems/123?api-version=6.0',
          DryRun: true,
          RequiresAllowWrite: true,
        }),
        stderr: '',
      };
    },
  });

  const result = await tool.execute(
    {
      method: 'PATCH',
      area: 'wit',
      resource: 'workitems/123',
      body: [{ op: 'add', path: '/fields/System.Title', value: 'Preview only' }],
      dryRun: true,
      jsonPatch: true,
    },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.match(receivedArgs[3] ?? '', /ConvertFrom-Json[^\n]+-NoEnumerate/);
  assert.equal(receivedEnv.ROCKETBOT_ADO_DRY_RUN, '1');
  assert.equal(receivedEnv.ROCKETBOT_ADO_JSON_PATCH, '1');
  assert.equal(receivedEnv.ROCKETBOT_ADO_ALLOW_WRITE, undefined);
  assert.match(String(result.data.summary), /dry-run/);
});

test('azure_devops_server_rest 应在显式 allowWrite 时透传 live 写操作', async () => {
  let receivedEnv: NodeJS.ProcessEnv = {};
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl: 'http://ado/DefaultCollection',
    scriptPath: 'D:\\skills\\Invoke-AzureDevOpsServerApi.ps1',
    runner: async (_command, _args, options) => {
      receivedEnv = options.env;
      return {
        stdout: JSON.stringify({
          id: 123,
          rev: 1,
          fields: {
            'System.Title': 'Created live',
          },
        }),
        stderr: '',
      };
    },
  });

  const result = await tool.execute(
    {
      method: 'PATCH',
      area: 'wit',
      resource: 'workitems/$Task',
      body: [{ op: 'add', path: '/fields/System.Title', value: 'Created live' }],
      allowWrite: true,
      jsonPatch: true,
    },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.equal(receivedEnv.ROCKETBOT_ADO_METHOD, 'PATCH');
  assert.equal(receivedEnv.ROCKETBOT_ADO_ALLOW_WRITE, '1');
  assert.equal(receivedEnv.ROCKETBOT_ADO_DRY_RUN, undefined);
  assert.equal(receivedEnv.ROCKETBOT_ADO_JSON_PATCH, '1');
  assert.match(String(result.data.summary), /写操作完成/);
  assert.equal(result.data.result.id, 123);
});
