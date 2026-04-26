import { execFile } from 'node:child_process';
import type { Logger } from '../utils/logger.js';
import type { Tool, ToolResult } from './registry.js';
import { createAzureDevOpsSource } from './source.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RunnerResult {
  stdout: string;
  stderr: string;
}

type PowerShellRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<RunnerResult>;

export interface AzureDevOpsServerRestToolOptions {
  collectionUrl: string;
  project?: string;
  team?: string;
  authMode?: 'pat' | 'default-credentials';
  pat?: string;
  apiVersion?: string;
  serverVersionHint?: '2022' | '2020' | '2019' | '2018' | '2017' | '2015' | 'legacy';
  searchBaseUrl?: string;
  testResultsBaseUrl?: string;
  scriptPath: string;
  powerShellPath?: string;
  timeoutMs?: number;
  runner?: PowerShellRunner;
}

export function createAzureDevOpsServerRestTool(opts: AzureDevOpsServerRestToolOptions): Tool {
  const timeout = opts.timeoutMs ?? 30000;

  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'azure_devops_server_rest',
        description:
          '通过项目内 Azure DevOps Server PowerShell wrapper 调用 on-prem Azure DevOps Server/TFS REST。' +
          '默认只允许 GET 和明确安全的 POST 读取路由；其他写操作必须先 dryRun 预览，再显式 allowWrite 才会 live 执行。',
        parameters: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              description: 'HTTP 方法，默认 GET',
            },
            area: {
              type: 'string',
              description: 'REST area，例如 git、wit、build、work、wiki、test、testplan、release、search',
            },
            resource: {
              type: 'string',
              description: '资源路径，例如 repositories、repositories/MyRepo/pullrequests、wiql、workitems/123',
            },
            project: { type: 'string', description: '项目名；未提供时使用配置默认值' },
            team: { type: 'string', description: 'Team-scoped work 路由的 team 名称' },
            query: {
              type: 'object',
              description: '查询参数对象，例如 { "$top": 20, "searchCriteria.status": "active" }',
            },
            body: {
              anyOf: [
                { type: 'object' },
                { type: 'array', items: {} },
                { type: 'string' },
              ],
              description: 'POST/PATCH/PUT body。读取型 POST 可使用；写操作应先 dryRun 预览。',
            },
            apiVersion: { type: 'string', description: '覆盖 api-version，例如 6.0 或 7.0' },
            serverVersionHint: {
              type: 'string',
              enum: ['2022', '2020', '2019', '2018', '2017', '2015', 'legacy'],
              description: 'Server 版本提示，用于选择默认 api-version',
            },
            allowConditionalArea: {
              type: 'boolean',
              description: '允许 release/search/testresults 等条件支持 area',
            },
            dryRun: {
              type: 'boolean',
              description: '只预览 method/url/query/body，不发送请求；写操作应先使用 dryRun',
            },
            allowWrite: {
              type: 'boolean',
              description: '显式允许 live 写操作。仅在已经 dryRun 审核过相同请求后使用。',
            },
            jsonPatch: {
              type: 'boolean',
              description: 'JSON Patch work item payload 时使用',
            },
          },
          required: ['resource'],
        },
      },
    },
    timeout,

    async execute(params: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const normalized = normalizeParams(params);
      if (!normalized.ok) {
        return { success: false, data: { error: normalized.error } };
      }

      const request = normalized.value;
      if (!isLiveReadAllowed(request.method, request.area, request.resource) && !request.dryRun && !request.allowWrite) {
        return {
          success: false,
          data: {
            error:
              'Azure DevOps Server live 写操作已被 RocketBot 拦截。请先设置 dryRun=true 预览；确认后再用 allowWrite=true 执行。',
          },
        };
      }

      logger.info('Azure DevOps Server REST 查询', {
        method: request.method,
        area: request.area,
        resource: request.resource,
        dryRun: request.dryRun,
        allowWrite: request.allowWrite,
      });

      try {
        const result = await runPowerShellWrapper(opts, request, timeout);
        const parsed = parsePowerShellJson(result.stdout);
        const ref = formatSourceRef(request.method, request.area, request.resource);
        const url = extractUri(parsed);

        return {
          success: true,
          data: {
            summary: request.dryRun
              ? 'Azure DevOps Server REST dry-run 预览完成'
              : request.allowWrite
                ? 'Azure DevOps Server REST 写操作完成'
                : 'Azure DevOps Server REST 查询完成',
            result: parsed ?? result.stdout.trim(),
            stderr: result.stderr.trim() || undefined,
            sources: [createAzureDevOpsSource(ref, url, ref)],
          },
        };
      } catch (error) {
        return {
          success: false,
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

interface NormalizedRequest {
  method: Method;
  area?: string;
  resource: string;
  project?: string;
  team?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  apiVersion?: string;
  serverVersionHint?: string;
  allowConditionalArea: boolean;
  dryRun: boolean;
  allowWrite: boolean;
  jsonPatch: boolean;
}

function normalizeParams(params: Record<string, unknown>):
  | { ok: true; value: NormalizedRequest }
  | { ok: false; error: string } {
  const method = String(params.method ?? 'GET').toUpperCase();
  if (!isMethod(method)) {
    return { ok: false, error: `不支持的 method: ${String(params.method)}` };
  }

  const resourceParam = normalizePathParam(params.resource);
  if (resourceParam === null) {
    return { ok: false, error: 'area/resource 不能是完整 URL、包含换行或包含 .. 路径段' };
  }
  const resourceParts = splitResourceQuery(resourceParam);
  if (resourceParts === null) {
    return { ok: false, error: 'resource query string 格式无效' };
  }
  if (!resourceParts.resource) {
    return { ok: false, error: 'resource 不能为空' };
  }

  const area = normalizePathParam(params.area);
  if (area === null) {
    return { ok: false, error: 'area/resource 不能是完整 URL、包含换行或包含 .. 路径段' };
  }

  const explicitQuery = params.query === undefined ? undefined : normalizeQuery(params.query);
  if (explicitQuery === null) {
    return { ok: false, error: 'query 必须是对象' };
  }
  const query = {
    ...resourceParts.query,
    ...(explicitQuery ?? {}),
  };

  return {
    ok: true,
    value: {
      method,
      area: area || undefined,
      resource: resourceParts.resource,
      project: normalizeString(params.project),
      team: normalizeString(params.team),
      query: Object.keys(query).length > 0 ? query : undefined,
      body: params.body,
      apiVersion: normalizeString(params.apiVersion),
      serverVersionHint: normalizeString(params.serverVersionHint),
      allowConditionalArea: params.allowConditionalArea === true,
      dryRun: params.dryRun === true,
      allowWrite: params.allowWrite === true,
      jsonPatch: params.jsonPatch === true,
    },
  };
}

function splitResourceQuery(resource: string): { resource: string; query: Record<string, unknown> } | null {
  const queryIndex = resource.indexOf('?');
  if (queryIndex < 0) {
    return { resource, query: {} };
  }

  const path = resource.slice(0, queryIndex).replace(/^\/+|\/+$/g, '');
  const queryText = resource.slice(queryIndex + 1);
  if (!queryText) {
    return { resource: path, query: {} };
  }

  try {
    const parsed = new URLSearchParams(queryText);
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.entries()) {
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    }

    return { resource: path, query };
  } catch {
    return null;
  }
}

function runPowerShellWrapper(
  opts: AzureDevOpsServerRestToolOptions,
  request: NormalizedRequest,
  timeout: number,
): Promise<RunnerResult> {
  const runner = opts.runner ?? execFileRunner;
  const command = opts.powerShellPath ?? 'pwsh';
  const args = ['-NoProfile', '-NonInteractive', '-Command', buildInvocationScript()];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROCKETBOT_ADO_SCRIPT_PATH: opts.scriptPath,
    ROCKETBOT_ADO_COLLECTION_URL: opts.collectionUrl,
    ROCKETBOT_ADO_AUTH_MODE: opts.authMode ?? (opts.pat ? 'pat' : 'default-credentials'),
    ROCKETBOT_ADO_PAT: opts.pat,
    ROCKETBOT_ADO_DEFAULT_PROJECT: opts.project,
    ROCKETBOT_ADO_DEFAULT_TEAM: opts.team,
    ROCKETBOT_ADO_API_VERSION: opts.apiVersion,
    ROCKETBOT_ADO_SERVER_VERSION: opts.serverVersionHint,
    ROCKETBOT_ADO_SEARCH_BASE_URL: opts.searchBaseUrl,
    ROCKETBOT_ADO_TESTRESULTS_BASE_URL: opts.testResultsBaseUrl,
    ROCKETBOT_ADO_METHOD: request.method,
    ROCKETBOT_ADO_AREA: request.area,
    ROCKETBOT_ADO_RESOURCE: request.resource,
    ROCKETBOT_ADO_PROJECT: request.project,
    ROCKETBOT_ADO_TEAM: request.team,
    ROCKETBOT_ADO_REQUEST_API_VERSION: request.apiVersion,
    ROCKETBOT_ADO_REQUEST_SERVER_VERSION: request.serverVersionHint,
    ROCKETBOT_ADO_QUERY_JSON: request.query ? JSON.stringify(request.query) : undefined,
    ROCKETBOT_ADO_BODY_JSON: request.body === undefined || typeof request.body === 'string'
      ? undefined
      : JSON.stringify(request.body),
    ROCKETBOT_ADO_BODY_TEXT: typeof request.body === 'string' ? request.body : undefined,
    ROCKETBOT_ADO_ALLOW_CONDITIONAL_AREA: request.allowConditionalArea ? '1' : undefined,
    ROCKETBOT_ADO_DRY_RUN: request.dryRun ? '1' : undefined,
    ROCKETBOT_ADO_ALLOW_WRITE: request.allowWrite && !request.dryRun ? '1' : undefined,
    ROCKETBOT_ADO_JSON_PATCH: request.jsonPatch ? '1' : undefined,
  };

  return runner(command, args, { env, timeout });
}

function buildInvocationScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$params = @{
  Method = $env:ROCKETBOT_ADO_METHOD
  Resource = $env:ROCKETBOT_ADO_RESOURCE
  CollectionUrl = $env:ROCKETBOT_ADO_COLLECTION_URL
}
if ($env:ROCKETBOT_ADO_AREA) { $params.Area = $env:ROCKETBOT_ADO_AREA }
if ($env:ROCKETBOT_ADO_PROJECT) { $params.Project = $env:ROCKETBOT_ADO_PROJECT } elseif ($env:ROCKETBOT_ADO_DEFAULT_PROJECT) { $params.Project = $env:ROCKETBOT_ADO_DEFAULT_PROJECT }
if ($env:ROCKETBOT_ADO_TEAM) { $params.Team = $env:ROCKETBOT_ADO_TEAM } elseif ($env:ROCKETBOT_ADO_DEFAULT_TEAM) { $params.Team = $env:ROCKETBOT_ADO_DEFAULT_TEAM }
if ($env:ROCKETBOT_ADO_AUTH_MODE) { $params.AuthMode = $env:ROCKETBOT_ADO_AUTH_MODE }
if ($env:ROCKETBOT_ADO_PAT) { $params.Pat = $env:ROCKETBOT_ADO_PAT }
if ($env:ROCKETBOT_ADO_REQUEST_API_VERSION) { $params.ApiVersion = $env:ROCKETBOT_ADO_REQUEST_API_VERSION } elseif ($env:ROCKETBOT_ADO_API_VERSION) { $params.ApiVersion = $env:ROCKETBOT_ADO_API_VERSION }
if ($env:ROCKETBOT_ADO_REQUEST_SERVER_VERSION) { $params.ServerVersionHint = $env:ROCKETBOT_ADO_REQUEST_SERVER_VERSION } elseif ($env:ROCKETBOT_ADO_SERVER_VERSION) { $params.ServerVersionHint = $env:ROCKETBOT_ADO_SERVER_VERSION }
if ($env:ROCKETBOT_ADO_SEARCH_BASE_URL) { $params.SearchBaseUrl = $env:ROCKETBOT_ADO_SEARCH_BASE_URL }
if ($env:ROCKETBOT_ADO_TESTRESULTS_BASE_URL) { $params.TestResultsBaseUrl = $env:ROCKETBOT_ADO_TESTRESULTS_BASE_URL }
if ($env:ROCKETBOT_ADO_QUERY_JSON) { $params.Query = ConvertFrom-Json -InputObject $env:ROCKETBOT_ADO_QUERY_JSON -AsHashtable }
if ($env:ROCKETBOT_ADO_BODY_JSON) { $params.Body = ConvertFrom-Json -InputObject $env:ROCKETBOT_ADO_BODY_JSON -Depth 100 -NoEnumerate }
if ($env:ROCKETBOT_ADO_BODY_TEXT) { $params.Body = $env:ROCKETBOT_ADO_BODY_TEXT }
if ($env:ROCKETBOT_ADO_ALLOW_CONDITIONAL_AREA) { $params.AllowConditionalArea = $true }
if ($env:ROCKETBOT_ADO_DRY_RUN) { $params.DryRun = $true }
if ($env:ROCKETBOT_ADO_ALLOW_WRITE) { $params.AllowWrite = $true }
if ($env:ROCKETBOT_ADO_JSON_PATCH) { $params.JsonPatch = $true }
$result = & $env:ROCKETBOT_ADO_SCRIPT_PATH @params
if ($null -ne $result) {
  $result | ConvertTo-Json -Depth 100 -Compress
}
`.trim();
}

function execFileRunner(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: options.env,
      timeout: options.timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`Azure DevOps Server wrapper 执行失败: ${detail}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function isLiveReadAllowed(method: Method, area: string | undefined, resource: string): boolean {
  if (method === 'GET') {
    return true;
  }

  if (method !== 'POST') {
    return false;
  }

  const normalizedArea = (area ?? '').trim().toLowerCase();
  const normalizedResource = resource.trim().replace(/^\/+|\/+$/g, '').toLowerCase();

  if (normalizedArea === 'wit') {
    return normalizedResource === 'wiql';
  }
  if (normalizedArea === 'wiki') {
    return /^wikis\/[^/]+\/pagesbatch$/.test(normalizedResource);
  }
  if (normalizedArea === 'search') {
    return ['workitemsearchresults', 'codesearchresults', 'wikisearchresults'].includes(normalizedResource);
  }

  return false;
}

function parsePowerShellJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function extractUri(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const uri = (value as Record<string, unknown>).Uri;
  return typeof uri === 'string' ? uri : undefined;
}

function formatSourceRef(method: Method, area: string | undefined, resource: string): string {
  const path = area ? `${area}/${resource}` : resource;
  return `${method} ${path}`;
}

function normalizePathParam(value: unknown): string | null {
  if (value === undefined || value === null) {
    return '';
  }

  const normalized = String(value).trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return '';
  }
  if (/^https?:\/\//i.test(normalized) || normalized.includes('\n') || normalized.split('/').includes('..')) {
    return null;
  }

  return normalized;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeQuery(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function isMethod(value: string): value is Method {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value);
}
