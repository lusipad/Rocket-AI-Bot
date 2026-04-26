import assert from 'node:assert/strict';
import test from 'node:test';
import { createAzureDevOpsTool } from '../src/tools/azure-devops.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('azure_devops 在提供 PR id 时应直接查询单个 PR', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = createAzureDevOpsTool({
    serverUrl: 'http://ado',
    pat: 'test',
    project: 'Demo',
    clientFactory: () => ({
      async getGitApi() {
        return {
          async getPullRequestById(id: number, project?: string) {
            calls.push({ fn: 'getPullRequestById', id, project });
            return {
              pullRequestId: id,
              title: 'Fix login race',
              status: 1,
              repository: { name: 'web-app' },
              sourceRefName: 'refs/heads/fix/login-race',
              targetRefName: 'refs/heads/main',
              createdBy: { displayName: 'alice' },
              url: 'http://ado/pr/42',
            };
          },
        };
      },
    }) as never,
  });

  const result = await tool.execute(
    { action: 'pr', id: 42 },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    fn: 'getPullRequestById',
    id: 42,
    project: 'Demo',
  }]);
  assert.equal(result.data.summary, '找到 PR #42');
  assert.deepEqual(result.data.prs, [{
    repo: 'web-app',
    prId: 42,
    title: 'Fix login race',
    status: '1',
    sourceBranch: 'refs/heads/fix/login-race',
    targetBranch: 'refs/heads/main',
    createdBy: 'alice',
    url: 'http://ado/pr/42',
  }]);
});

test('azure_devops 在按仓库查询 PR 时应解析仓库名并按 query 过滤', async () => {
  let receivedRepoId: string | undefined;
  let receivedStatus: unknown;
  const tool = createAzureDevOpsTool({
    serverUrl: 'http://ado',
    pat: 'test',
    project: 'Demo',
    clientFactory: () => ({
      async getGitApi() {
        return {
          async getRepositories(project: string) {
            assert.equal(project, 'Demo');
            return [{ id: 'repo-1', name: 'web-app' }];
          },
          async getPullRequests(repositoryId: string, searchCriteria: Record<string, unknown>) {
            receivedRepoId = repositoryId;
            receivedStatus = searchCriteria.status;
            return [
              {
                pullRequestId: 101,
                title: 'Auth cleanup',
                status: 1,
                repository: { name: 'web-app' },
                url: 'http://ado/pr/101',
              },
              {
                pullRequestId: 102,
                title: 'Navbar polish',
                status: 1,
                repository: { name: 'web-app' },
                url: 'http://ado/pr/102',
              },
            ];
          },
        };
      },
    }) as never,
  });

  const result = await tool.execute(
    { action: 'pr', repo: 'web-app', query: 'auth', status: 'all' },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.equal(receivedRepoId, 'repo-1');
  assert.equal(receivedStatus, 4);
  assert.equal(Array.isArray(result.data.prs), true);
  assert.equal((result.data.prs as Array<unknown>).length, 1);
  assert.match(JSON.stringify(result.data.prs), /Auth cleanup/);
});

test('azure_devops 在提供 pipeline id 时应查询单个定义并只取最近一次构建', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = createAzureDevOpsTool({
    serverUrl: 'http://ado',
    pat: 'test',
    project: 'Demo',
    clientFactory: () => ({
      async getBuildApi() {
        return {
          async getDefinition(project: string, definitionId: number) {
            calls.push({ fn: 'getDefinition', project, definitionId });
            return {
              id: definitionId,
              name: 'build-main',
              url: 'http://ado/pipeline/77',
            };
          },
          async getBuilds(
            project: string,
            definitions: number[],
            _queues?: unknown,
            _buildNumber?: unknown,
            _minTime?: unknown,
            _maxTime?: unknown,
            _requestedFor?: unknown,
            _reasonFilter?: unknown,
            _statusFilter?: unknown,
            _resultFilter?: unknown,
            _tagFilters?: unknown,
            _properties?: unknown,
            top?: number,
          ) {
            calls.push({ fn: 'getBuilds', project, definitions, top });
            return [{
              status: 'completed',
              result: 'succeeded',
              buildNumber: '2026.04.26.1',
            }];
          },
        };
      },
    }) as never,
  });

  const result = await tool.execute(
    { action: 'pipeline', id: 77 },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    { fn: 'getDefinition', project: 'Demo', definitionId: 77 },
    { fn: 'getBuilds', project: 'Demo', definitions: [77], top: 1 },
  ]);
  assert.match(JSON.stringify(result.data.pipelines), /build-main/);
  assert.match(JSON.stringify(result.data.sources), /Pipeline #77/);
});

test('azure_devops 在 work item query 为纯数字时应按 id 查询', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = createAzureDevOpsTool({
    serverUrl: 'http://ado',
    pat: 'test',
    project: 'Demo',
    clientFactory: () => ({
      async getWorkItemTrackingApi() {
        return {
          async getWorkItem(id: number) {
            calls.push({ fn: 'getWorkItem', id });
            return {
              id,
              fields: {
                'System.Title': 'Investigate login bug',
                'System.State': 'Active',
                'System.WorkItemType': 'Bug',
              },
              url: 'http://ado/wi/1234',
            };
          },
        };
      },
    }) as never,
  });

  const result = await tool.execute(
    { action: 'work_item', query: '1234' },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ fn: 'getWorkItem', id: 1234 }]);
  assert.equal(result.data.id, 1234);
});
