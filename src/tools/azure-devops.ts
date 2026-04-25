/* eslint-disable @typescript-eslint/no-explicit-any */
import * as azdev from 'azure-devops-node-api';
import type { Tool, ToolResult } from './registry.js';
import type { Logger } from '../utils/logger.js';

export function createAzureDevOpsTool(opts: {
  serverUrl: string;
  pat: string;
  project: string;
}): Tool {
  let client: azdev.WebApi | null = null;

  function getClient(): azdev.WebApi {
    if (!client) {
      const authHandler = azdev.getPersonalAccessTokenHandler(opts.pat);
      client = new azdev.WebApi(opts.serverUrl, authHandler);
    }
    return client;
  }

  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'azure_devops',
        description:
          '查询 Azure DevOps Server 上的工作项、Pull Request 状态和构建流水线。' +
          '通过 action 参数区分: work_item (按 ID 或 WIQL)、pr (按仓库或 ID)、pipeline (按名称或 ID)。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['work_item', 'pr', 'pipeline'],
              description: '查询类型',
            },
            id: { type: 'number', description: '工作项 ID / PR ID / Pipeline ID' },
            query: { type: 'string', description: 'WIQL 查询、PR 名称或 Pipeline 名称' },
            repo: { type: 'string', description: 'Git 仓库名 (PR/Pipeline 查询时使用)' },
            status: { type: 'string', description: '状态过滤' },
          },
          required: ['action'],
        },
      },
    },
    timeout: 15000,

    async execute(params: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const action = String(params.action ?? '');
      logger.info('Azure DevOps 查询', { action, params });

      try {
        switch (action) {
          case 'work_item': return queryWorkItems(getClient(), opts.project, params);
          case 'pr': return queryPRs(getClient(), opts.project, params);
          case 'pipeline': return queryPipelines(getClient(), opts.project, params);
          default: return { success: false, data: { error: `未知 action: ${action}` } };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, data: { error: `Azure DevOps 查询失败: ${msg}` } };
      }
    },
  };
}

async function queryWorkItems(
  client: azdev.WebApi,
  project: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const witApi = await client.getWorkItemTrackingApi();

  if (params.id) {
    const id = Number(params.id);
    const wi = await witApi.getWorkItem(id);
    return {
      success: true,
      data: {
        id: wi.id,
        title: wi.fields?.['System.Title'],
        state: wi.fields?.['System.State'],
        assignedTo: wi.fields?.['System.AssignedTo'],
        type: wi.fields?.['System.WorkItemType'],
        url: wi.url,
      },
    };
  }

  // WIQL 查询
  const wiql = String(params.query ?? 'SELECT [System.Id],[System.Title],[System.State] FROM WorkItems');
  const result = await witApi.queryByWiql({ query: wiql }, { project });
  const ids = result.workItems?.slice(0, 10).map(w => w.id).filter(Boolean) as number[] ?? [];

  if (ids.length === 0) {
    return { success: true, data: { summary: '未找到匹配的工作项', items: [] } };
  }

  const items = await witApi.getWorkItems(ids);
  return {
    success: true,
    data: {
      summary: `找到 ${items.length} 个结果`,
      items: items.map(wi => ({
        id: wi.id,
        title: wi.fields?.['System.Title'],
        state: wi.fields?.['System.State'],
        type: wi.fields?.['System.WorkItemType'],
      })),
    },
  };
}

async function queryPRs(
  client: azdev.WebApi,
  project: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const gitApi = await client.getGitApi();
  const repoName = params.repo ? String(params.repo) : undefined;

  let repos: string[] = [];
  if (repoName) {
    repos = [repoName];
  } else {
    const allRepos = await gitApi.getRepositories(project);
    repos = allRepos.slice(0, 5).map(r => r.name!).filter(Boolean);
  }

  const allPRs: { repo: string; prId: number; title: string; status: string }[] = [];
  for (const repo of repos) {
    const prs = await gitApi.getPullRequests(repo, { status: 1 }, project); // status=1=active
    for (const pr of prs.slice(0, 5)) {
      allPRs.push({
        repo,
        prId: pr.pullRequestId!,
        title: pr.title!,
        status: String(pr.status),
      });
    }
  }

  return {
    success: true,
    data: {
      summary: `找到 ${allPRs.length} 个 PR`,
      prs: allPRs,
    },
  };
}

async function queryPipelines(
  client: azdev.WebApi,
  project: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const buildApi = await client.getBuildApi();

  const defs = await buildApi.getDefinitions(project, params.pipelineId ? String(params.pipelineId) : undefined);
  const recent = await Promise.all(
    defs.slice(0, 5).map(async (d) => {
      const builds: any[] = await buildApi.getBuilds(project, [d.id!], undefined, undefined, undefined, undefined, undefined, 1);
      return {
        pipeline: d.name!,
        pipelineId: d.id!,
        lastBuild: builds[0] ? {
          status: builds[0].status,
          result: builds[0].result,
          buildNumber: builds[0].buildNumber,
        } : null,
      };
    }),
  );

  return {
    success: true,
    data: {
      summary: `查询完成`,
      pipelines: recent,
    },
  };
}
