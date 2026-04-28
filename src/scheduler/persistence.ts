import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/helpers.js';

export interface TaskDef {
  name: string;
  templateId?: string;
  prompt?: string;
  cron: string;
  room: string;
  enabled: boolean;
}

export interface TaskHistory {
  taskName: string;
  timestamp: string;
  success: boolean;
  output?: string;
  error?: string;
}

export class TaskPersistence {
  private tasksPath: string;
  private historyDir: string;

  constructor(tasksPath = 'data/scheduler/tasks.json', historyDir = 'data/scheduler/history') {
    this.tasksPath = tasksPath;
    this.historyDir = historyDir;
    ensureDir(path.dirname(this.tasksPath));
    ensureDir(this.historyDir);
  }

  loadTasks(): TaskDef[] {
    try {
      const raw = fs.readFileSync(this.tasksPath, 'utf-8');
      const tasks = JSON.parse(raw) as TaskDef[];
      return tasks.map(normalizeTask);
    } catch {
      return [];
    }
  }

  saveTasks(tasks: TaskDef[]): void {
    fs.writeFileSync(this.tasksPath, JSON.stringify(tasks.map(normalizeTask), null, 2), 'utf-8');
  }

  recordHistory(taskName: string, success: boolean, output?: string, error?: string): void {
    const history: TaskHistory = {
      taskName,
      timestamp: new Date().toISOString(),
      success,
      output: output?.slice(0, 5000),
      error: error?.slice(0, 2000),
    };
    const filePath = path.join(this.historyDir, `${taskName}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
  }

  getRecentHistory(taskName?: string, limit = 20): TaskHistory[] {
    const files = fs.readdirSync(this.historyDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    const results: TaskHistory[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.historyDir, f), 'utf-8')) as TaskHistory;
        if (!taskName || data.taskName === taskName) {
          results.push(data);
        }
      } catch { /* skip corrupt */ }
    }
    return results;
  }
}

function normalizeTask(task: TaskDef): TaskDef {
  const { templateId: rawTemplateId, ...rest } = task;
  const prompt = task.prompt?.trim();
  const templateId = rawTemplateId?.trim();
  return {
    ...rest,
    ...(templateId ? { templateId } : {}),
    prompt: prompt || task.name,
  };
}
