const BASE = '/api';

let token: string | null = null;

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

export async function getTasks(): Promise<any[]> {
  return request('/tasks');
}

export async function createTask(task: { name: string; cron: string; room: string; enabled: boolean }): Promise<void> {
  return request('/tasks', { method: 'POST', body: JSON.stringify(task) });
}

export async function updateTask(name: string, task: Partial<{ cron: string; room: string; enabled: boolean }>): Promise<void> {
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
