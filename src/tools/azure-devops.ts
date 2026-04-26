/* eslint-disable @typescript-eslint/no-explicit-any */
import * as azdev from 'azure-devops-node-api';
import type * as BuildInterfaces from 'azure-devops-node-api/interfaces/BuildInterfaces';
import type { Tool, ToolResult } from './registry.js';
import type { Logger } from '../utils/logger.js';
import { createAzureDevOpsSource, dedupeSources } from './source.js';

const PULL_REQUEST_STATUS = {
  Active: 1,
  Abandoned: 2,
  Completed: 3,
  All: 4,
} as const;

export function createAzureDevOpsTool(opts: {
  serverUrl: string;
  pat: string;
  project: string;
  clientFactory?: () => azdev.WebApi;
}): Tool {
  let client: azdev.WebApi | null = null;

  function getClient(): azdev.WebApi {
    if (!client) {
      if (opts.clientFactory) {
        client = opts.clientFactory();
      } else {
        const authHandler = azdev.getPersonalAccessTokenHandler(opts.pat);
        client = new azdev.WebApi(opts.serverUrl, authHandler);
      }
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
  const explicitId = normalizeNumericId(params.id);
  const queryText = typeof params.query === 'string' ? params.query.trim() : '';

  if (explicitId !== undefined || /^\d+$/.test(queryText)) {
    const id = explicitId ?? Number(queryText);
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
        sources: wi.id
          ? [createAzureDevOpsSource(`Work Item #${wi.id}`, wi.url ?? undefined)]
          : [],
      },
    };
  }

  // WIQL 查询
  const wiql = queryText || 'SELECT [System.Id],[System.Title],[System.State] FROM WorkItems';
  const result = await witApi.queryByWiql({ query: wiql }, { project });
  const ids = result.workItems?.slice(0, 10).map(w => w.id).filter(Boolean) as number[] ?? [];

  if (ids.length === 0) {
    return { success: true, data: { summary: '未找到匹配的工作项', items: [], sources: [] } };
  }

  const items = await witApi.getWorkItems(ids);
  const mappedItems = items.map(wi => ({
    id: wi.id,
    title: wi.fields?.['System.Title'],
    state: wi.fields?.['System.State'],
    type: wi.fields?.['System.WorkItemType'],
    url: wi.url,
  }));
  return {
    success: true,
    data: {
      summary: `找到 ${mappedItems.length} 个结果`,
      items: mappedItems,
      sources: dedupeSources(
        mappedItems
          .filter((wi) => Number.isFinite(Number(wi.id)))
          .map((wi) => createAzureDevOpsSource(`Work Item #${wi.id}`, wi.url ?? undefined)),
      ),
    },
  };
}

async function queryPRs(
  client: azdev.WebApi,
  project: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const gitApi = await client.getGitApi();
  const repoRef = typeof params.repo === 'string' ? params.repo.trim() : undefined;
  const queryText = typeof params.query === 'string' ? params.query.trim() : '';
  const prId = normalizeNumericId(params.id);
  const status = normalizePullRequestStatus(params.status);

  if (prId !== undefined) {
    const pr = await gitApi.getPullRequestById(prId, project);
    const mappedPr = mapPullRequest(pr);
    return {
      success: true,
      data: {
        summary: `找到 PR #${mappedPr.prId}`,
        prs: [mappedPr],
        sources: [createAzureDevOpsSource(`PR #${mappedPr.prId} (${mappedPr.repo})`, mappedPr.url)],
      },
    };
  }

  let prs: any[] = [];
  if (repoRef) {
    const repo = await resolveRepository(gitApi, project, repoRef);
    if (!repo?.id) {
      return {
        success: true,
        data: {
          summary: `未找到仓库: ${repoRef}`,
          prs: [],
          sources: [],
        },
      };
    }
    prs = await gitApi.getPullRequests(repo.id, buildPullRequestSearchCriteria(status), project, undefined, undefined, 10);
  } else {
    prs = await gitApi.getPullRequestsByProject(project, buildPullRequestSearchCriteria(status), undefined, undefined, 20);
  }

  if (queryText) {
    const lowered = queryText.toLowerCase();
    prs = prs.filter((pr: any) => {
      const title = pr.title?.toLowerCase() ?? '';
      const repoName = pr.repository?.name?.toLowerCase() ?? '';
      const sourceRef = pr.sourceRefName?.toLowerCase() ?? '';
      const targetRef = pr.targetRefName?.toLowerCase() ?? '';
      return title.includes(lowered)
        || repoName.includes(lowered)
        || sourceRef.includes(lowered)
        || targetRef.includes(lowered);
    });
  }

  const allPRs = prs.slice(0, 10).map(mapPullRequest);
  return {
    success: true,
    data: {
      summary: `找到 ${allPRs.length} 个 PR`,
      prs: allPRs,
      sources: dedupeSources(
        allPRs.map((pr) => createAzureDevOpsSource(`PR #${pr.prId} (${pr.repo})`, pr.url)),
      ),
    },
  };
}

async function queryPipelines(
  client: azdev.WebApi,
  project: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const buildApi = await client.getBuildApi();
  const pipelineId = normalizeNumericId(params.id);
  const queryText = typeof params.query === 'string' ? params.query.trim() : '';

  let defs: BuildInterfaces.BuildDefinitionReference[] = [];
  if (pipelineId !== undefined) {
    const definition = await buildApi.getDefinition(project, pipelineId, undefined, undefined, undefined, true);
    defs = [definition];
  } else {
    const allDefs = await buildApi.getDefinitions(project, undefined, undefined, undefined, undefined, 50);
    defs = queryText
      ? allDefs.filter((definition) => definition.name?.toLowerCase().includes(queryText.toLowerCase()))
      : allDefs;
  }

  const recent = await Promise.all(
    defs.slice(0, 5).map(async (d) => {
      const builds: any[] = await buildApi.getBuilds(
        project,
        [d.id!],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
      );
      return {
        pipeline: d.name!,
        pipelineId: d.id!,
        url: d.url ?? undefined,
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
      sources: dedupeSources(
        recent.map((pipeline) => createAzureDevOpsSource(
          `Pipeline #${pipeline.pipelineId} (${pipeline.pipeline})`,
          pipeline.url,
        )),
      ),
    },
  };
}

function normalizeNumericId(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizePullRequestStatus(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'active':
    case 'open':
      return PULL_REQUEST_STATUS.Active;
    case 'abandoned':
    case 'closed':
      return PULL_REQUEST_STATUS.Abandoned;
    case 'completed':
    case 'merged':
      return PULL_REQUEST_STATUS.Completed;
    case 'all':
      return PULL_REQUEST_STATUS.All;
    default:
      return undefined;
  }
}

function buildPullRequestSearchCriteria(
  status?: number,
): { status: number } {
  return {
    status: status ?? PULL_REQUEST_STATUS.Active,
  };
}

async function resolveRepository(
  gitApi: { getRepositories(project: string): Promise<Array<{ id?: string; name?: string }>> },
  project: string,
  repoRef: string,
): Promise<{ id?: string; name?: string } | undefined> {
  const repos = await gitApi.getRepositories(project);
  const lowered = repoRef.toLowerCase();
  return repos.find((repo) => repo.id === repoRef || repo.name?.toLowerCase() === lowered);
}

function mapPullRequest(pr: {
  repository?: { name?: string };
  pullRequestId?: number;
  title?: string;
  status?: unknown;
  sourceRefName?: string;
  targetRefName?: string;
  createdBy?: { displayName?: string };
  url?: string;
}): {
  repo: string;
  prId: number;
  title: string;
  status: string;
  sourceBranch?: string;
  targetBranch?: string;
  createdBy?: string;
  url?: string;
} {
  return {
    repo: pr.repository?.name ?? 'unknown',
    prId: pr.pullRequestId ?? 0,
    title: pr.title ?? '',
    status: normalizeEnumLabel(pr.status),
    sourceBranch: pr.sourceRefName ?? undefined,
    targetBranch: pr.targetRefName ?? undefined,
    createdBy: pr.createdBy?.displayName ?? undefined,
    url: pr.url ?? undefined,
  };
}

function normalizeEnumLabel(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return 'unknown';
}
