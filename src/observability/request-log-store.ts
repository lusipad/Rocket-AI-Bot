import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/helpers.js';
import { isAgentRequestType } from '../agent-core/classification.js';
import type { AgentRequestType } from '../agent-core/types.js';
import { dedupeSources, type ToolSource } from '../tools/source.js';

export type RequestLogKind = 'chat' | 'scheduler';
export type RequestLogStatus = 'success' | 'error' | 'rejected';
export type RequestLogSkillSource = 'explicit' | 'model' | 'system';
export type RequestLogContextScope = 'direct' | 'group' | 'thread';

export interface RequestLogContext {
  scope: RequestLogContextScope;
  discussionRequest: boolean;
  recentMessageCount: number;
  recentMessageLimit: number;
  summaryEnabled: boolean;
  summaryInjected: boolean;
  summaryScope?: 'room' | 'thread';
  currentImageCount: number;
  recentImageCount: number;
  nativeWebSearchEnabled: boolean;
  webSearchUsed: boolean;
  modelMode?: 'normal' | 'deep';
  publicChannelLookbackMinutes?: number;
}

export interface RequestLogEntry {
  requestId: string;
  agentId?: string;
  agentName?: string;
  kind: RequestLogKind;
  status: RequestLogStatus;
  finishReason?: string;
  requestType?: AgentRequestType;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  userId?: string;
  username?: string;
  roomId?: string;
  roomType?: 'c' | 'p' | 'd' | 'l';
  threadId?: string;
  triggerMessageId?: string;
  taskName?: string;
  taskTemplateId?: string;
  prompt: string;
  reply?: string;
  error?: string;
  activeSkills: string[];
  skillSources: Record<string, RequestLogSkillSource>;
  usedTools: string[];
  rounds: number;
  sources?: ToolSource[];
  context?: RequestLogContext;
}

export interface RequestLogQuery {
  kind?: RequestLogKind;
  status?: RequestLogStatus;
  requestType?: AgentRequestType;
  username?: string;
  roomId?: string;
  taskName?: string;
  limit?: number;
}

export interface RequestLogSummary {
  total: number;
  success: number;
  error: number;
  rejected: number;
  byKind: Record<RequestLogKind, number>;
  byRequestType: Partial<Record<AgentRequestType, number>>;
  sourceCoverage: {
    withSources: number;
    sourceRate: number;
  };
  lastFinishedAt?: string;
}

export interface RequestLogDevToolsMetrics {
  total: number;
  devToolsTotal: number;
  devToolsRate: number;
  byRequestType: Partial<Record<AgentRequestType, number>>;
  byTool: Record<string, number>;
  sourceCoverage: {
    withSources: number;
    sourceRate: number;
  };
  lastFinishedAt?: string;
}

const DEFAULT_LIST_LIMIT = 50;
const DEVTOOLS_REQUEST_TYPES = new Set<AgentRequestType>([
  'code_query',
  'ado_query',
  'ado_file_review',
  'ado_file_lookup',
  'pr_review',
  'pipeline_monitor',
  'work_item_report',
]);

export class RequestLogStore {
  private historyDir: string;

  constructor(historyDir = 'data/requests/history') {
    this.historyDir = historyDir;
    ensureDir(this.historyDir);
  }

  record(entry: RequestLogEntry): void {
    const normalized = normalizeEntry(entry);
    const timestamp = new Date(normalized.finishedAt).getTime();
    const safeRequestId = normalized.requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(this.historyDir, `${timestamp}-${safeRequestId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  list(query: RequestLogQuery = {}): RequestLogEntry[] {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, 200));
    const files = this.getSortedFiles();
    const results: RequestLogEntry[] = [];

    for (const file of files) {
      const entry = this.readEntry(file);
      if (!entry) {
        continue;
      }

      if (!matchesQuery(entry, query)) {
        continue;
      }

      results.push(entry);
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  get(requestId: string): RequestLogEntry | null {
    const files = this.getSortedFiles();
    for (const file of files) {
      const entry = this.readEntry(file);
      if (entry?.requestId === requestId) {
        return entry;
      }
    }

    return null;
  }

  summarizeRecent(limit = DEFAULT_LIST_LIMIT): RequestLogSummary {
    const entries = this.list({ limit });
    const summary: RequestLogSummary = {
      total: entries.length,
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
      lastFinishedAt: entries[0]?.finishedAt,
    };

    for (const entry of entries) {
      switch (entry.status) {
        case 'success':
          summary.success += 1;
          break;
        case 'error':
          summary.error += 1;
          break;
        case 'rejected':
          summary.rejected += 1;
          break;
      }
      summary.byKind[entry.kind] += 1;
      if (entry.requestType) {
        summary.byRequestType[entry.requestType] = (summary.byRequestType[entry.requestType] ?? 0) + 1;
      }
      if ((entry.sources?.length ?? 0) > 0) {
        summary.sourceCoverage.withSources += 1;
      }
    }
    summary.sourceCoverage.sourceRate = summary.total === 0
      ? 0
      : roundRate(summary.sourceCoverage.withSources / summary.total);

    return summary;
  }

  summarizeDevTools(limit = 200): RequestLogDevToolsMetrics {
    const entries = this.list({ limit });
    const devToolsEntries = entries.filter(isDevToolsEntry);
    const metrics: RequestLogDevToolsMetrics = {
      total: entries.length,
      devToolsTotal: devToolsEntries.length,
      devToolsRate: entries.length === 0 ? 0 : roundRate(devToolsEntries.length / entries.length),
      byRequestType: {},
      byTool: {},
      sourceCoverage: {
        withSources: 0,
        sourceRate: 0,
      },
      lastFinishedAt: entries[0]?.finishedAt,
    };

    for (const entry of devToolsEntries) {
      if (entry.requestType) {
        metrics.byRequestType[entry.requestType] = (metrics.byRequestType[entry.requestType] ?? 0) + 1;
      }
      for (const tool of entry.usedTools) {
        metrics.byTool[tool] = (metrics.byTool[tool] ?? 0) + 1;
      }
      if ((entry.sources?.length ?? 0) > 0) {
        metrics.sourceCoverage.withSources += 1;
      }
    }
    metrics.sourceCoverage.sourceRate = devToolsEntries.length === 0
      ? 0
      : roundRate(metrics.sourceCoverage.withSources / devToolsEntries.length);

    return metrics;
  }

  private getSortedFiles(): string[] {
    return fs.readdirSync(this.historyDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .reverse();
  }

  private readEntry(fileName: string): RequestLogEntry | null {
    try {
      return normalizeEntry(JSON.parse(fs.readFileSync(path.join(this.historyDir, fileName), 'utf8')) as RequestLogEntry);
    } catch {
      return null;
    }
  }
}

function matchesQuery(entry: RequestLogEntry, query: RequestLogQuery): boolean {
  if (query.kind && entry.kind !== query.kind) {
    return false;
  }

  if (query.status && entry.status !== query.status) {
    return false;
  }

  if (query.requestType && entry.requestType !== query.requestType) {
    return false;
  }

  if (query.username && entry.username !== query.username) {
    return false;
  }

  if (query.roomId && entry.roomId !== query.roomId) {
    return false;
  }

  if (query.taskName && entry.taskName !== query.taskName) {
    return false;
  }

  return true;
}

function isDevToolsEntry(entry: RequestLogEntry): boolean {
  return Boolean(
    (entry.requestType && DEVTOOLS_REQUEST_TYPES.has(entry.requestType))
    || entry.usedTools.some((tool) => (
      tool === 'search_code'
      || tool === 'read_file'
      || tool === 'azure_devops'
      || tool === 'azure_devops_server_rest'
    )),
  );
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeEntry(entry: RequestLogEntry): RequestLogEntry {
  const activeSkills = dedupe(entry.activeSkills);
  return {
    ...entry,
    prompt: truncateRequired(entry.prompt, 4000),
    agentId: normalizeOptionalText(entry.agentId, 80),
    agentName: normalizeOptionalText(entry.agentName, 120),
    reply: truncate(entry.reply, 4000),
    error: truncate(entry.error, 2000),
    requestType: isAgentRequestType(entry.requestType) ? entry.requestType : undefined,
    activeSkills,
    skillSources: normalizeSkillSources(entry.skillSources, activeSkills),
    usedTools: dedupe(entry.usedTools),
    rounds: Math.max(0, entry.rounds),
    durationMs: Math.max(0, Math.round(entry.durationMs)),
    sources: normalizeSources(entry.sources),
    context: normalizeContext(entry.context),
  };
}

function normalizeOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return truncateRequired(value.trim(), maxLength);
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return value;
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function truncateRequired(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeSources(sources: ToolSource[] | undefined): ToolSource[] {
  if (!Array.isArray(sources)) {
    return [];
  }

  const normalized = sources
    .filter((source) => source && typeof source === 'object')
    .map((source) => ({
      type: source.type,
      title: truncateRequired(String(source.title ?? source.ref ?? ''), 200),
      ref: truncateRequired(String(source.ref ?? ''), 300),
      ...(source.url ? { url: truncateRequired(String(source.url), 500) } : {}),
    }))
    .filter((source): source is ToolSource => (
      (source.type === 'file' || source.type === 'azure_devops' || source.type === 'web' || source.type === 'chat')
      && Boolean(source.title)
      && Boolean(source.ref)
    ));

  return dedupeSources(normalized).slice(0, 20);
}

function normalizeSkillSources(
  sources: Record<string, RequestLogSkillSource> | undefined,
  activeSkills: string[],
): Record<string, RequestLogSkillSource> {
  const result: Record<string, RequestLogSkillSource> = {};
  if (!sources) {
    return result;
  }

  const activeSkillSet = new Set(activeSkills);
  for (const [name, source] of Object.entries(sources)) {
    if (!activeSkillSet.has(name)) {
      continue;
    }
    if (source === 'explicit' || source === 'model' || source === 'system') {
      result[name] = source;
    }
  }

  return result;
}

function normalizeContext(context: RequestLogContext | undefined): RequestLogContext | undefined {
  if (!context) {
    return undefined;
  }

  return {
    scope: context.scope === 'direct' || context.scope === 'group' || context.scope === 'thread'
      ? context.scope
      : 'group',
    discussionRequest: Boolean(context.discussionRequest),
    recentMessageCount: Math.max(0, Math.round(context.recentMessageCount)),
    recentMessageLimit: Math.max(0, Math.round(context.recentMessageLimit)),
    summaryEnabled: Boolean(context.summaryEnabled),
    summaryInjected: Boolean(context.summaryInjected),
    summaryScope: context.summaryScope === 'room' || context.summaryScope === 'thread'
      ? context.summaryScope
      : undefined,
    currentImageCount: Math.max(0, Math.round(context.currentImageCount)),
    recentImageCount: Math.max(0, Math.round(context.recentImageCount)),
    nativeWebSearchEnabled: Boolean(context.nativeWebSearchEnabled),
    webSearchUsed: Boolean(context.webSearchUsed),
    modelMode: context.modelMode === 'deep' ? 'deep' : context.modelMode === 'normal' ? 'normal' : undefined,
    publicChannelLookbackMinutes: context.publicChannelLookbackMinutes === undefined
      ? undefined
      : Math.max(1, Math.round(context.publicChannelLookbackMinutes)),
  };
}
