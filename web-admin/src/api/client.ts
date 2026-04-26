const BASE = '/api';

let token: string | null = null;

export interface Task {
  name: string;
  prompt: string;
  cron: string;
  room: string;
  enabled: boolean;
}

export interface Skill {
  name: string;
  description: string;
  allowedTools: string[];
  filePath: string;
  enabled: boolean;
}

export interface SkillDetail extends Skill {
  directory: string;
  instructions: string;
}

export interface RequestLog {
  requestId: string;
  kind: 'chat' | 'scheduler';
  status: 'success' | 'error' | 'rejected';
  finishReason?: string;
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
  prompt: string;
  reply?: string;
  error?: string;
  activeSkills: string[];
  skillSources: Record<string, 'explicit' | 'model' | 'system'>;
  usedTools: string[];
  rounds: number;
  context?: {
    modelMode?: 'normal' | 'deep';
  };
}

export interface RequestSummary {
  total: number;
  success: number;
  error: number;
  rejected: number;
  byKind: {
    chat: number;
    scheduler: number;
  };
  lastFinishedAt?: string;
}

export interface InstallSkillRequest {
  source: string;
  subdir?: string;
}

export interface ApiModeProbeResult {
  mode: 'chat_completions' | 'responses';
  ok: boolean;
  durationMs: number;
  model?: string;
  reply?: string;
  error?: string;
}

export interface ApiModeProbeSummary {
  current: 'chat_completions' | 'responses';
  recommended?: 'chat_completions' | 'responses';
  results: ApiModeProbeResult[];
}

export function setToken(t: string | null) { token = t; }
export function getToken(): string | null { return token; }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

export async function getStatus(): Promise<any> {
  return request('/status');
}

export async function probeApiModes(): Promise<ApiModeProbeSummary> {
  return request('/status/llm-api-mode-probe', { method: 'POST' });
}

export async function getRequests(params?: {
  kind?: 'chat' | 'scheduler';
  status?: 'success' | 'error' | 'rejected';
  username?: string;
  roomId?: string;
  taskName?: string;
  limit?: number;
}): Promise<RequestLog[]> {
  const search = new URLSearchParams();
  if (params?.kind) search.set('kind', params.kind);
  if (params?.status) search.set('status', params.status);
  if (params?.username) search.set('username', params.username);
  if (params?.roomId) search.set('roomId', params.roomId);
  if (params?.taskName) search.set('taskName', params.taskName);
  if (params?.limit) search.set('limit', String(params.limit));
  return request(`/requests?${search.toString()}`);
}

export async function getRequest(requestId: string): Promise<RequestLog> {
  return request(`/requests/${encodeURIComponent(requestId)}`);
}

export async function getRequestSummary(limit?: number): Promise<RequestSummary> {
  const search = new URLSearchParams();
  if (limit) search.set('limit', String(limit));
  return request(`/requests/summary/recent?${search.toString()}`);
}

export async function getTasks(): Promise<Task[]> {
  return request('/tasks');
}

export async function getSkills(): Promise<Skill[]> {
  return request('/skills');
}

export async function getSkill(name: string): Promise<SkillDetail> {
  return request(`/skills/${encodeURIComponent(name)}`);
}

export async function reloadSkills(): Promise<Skill[]> {
  const response = await request<{ ok: boolean; skills: Skill[] }>('/skills/reload', {
    method: 'POST',
  });
  return response.skills;
}

export async function updateSkill(name: string, enabled: boolean): Promise<Skill> {
  return request(`/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteSkill(name: string): Promise<Skill[]> {
  const response = await request<{ ok: boolean; skills: Skill[] }>(`/skills/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  return response.skills;
}

export async function installSkill(input: InstallSkillRequest): Promise<{ skills: Skill[]; installed: SkillDetail }> {
  return request('/skills/install', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createTask(task: Task): Promise<void> {
  return request('/tasks', { method: 'POST', body: JSON.stringify(task) });
}

export async function updateTask(name: string, task: Partial<Pick<Task, 'prompt' | 'cron' | 'room' | 'enabled'>>): Promise<void> {
  return request(`/tasks/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(task) });
}

export async function deleteTask(name: string): Promise<void> {
  return request(`/tasks/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function runTask(name: string): Promise<any> {
  return request(`/tasks/${encodeURIComponent(name)}/run`, { method: 'POST' });
}

export async function getHistory(name?: string, limit?: number): Promise<any[]> {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (limit) params.set('limit', String(limit));
  return request(`/tasks/history?${params.toString()}`);
}
