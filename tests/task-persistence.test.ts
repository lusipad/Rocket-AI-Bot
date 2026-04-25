import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskPersistence } from '../src/scheduler/persistence.ts';

test('TaskPersistence 应兼容旧任务数据并回填 prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-task-'));
  const tasksPath = path.join(root, 'tasks.json');
  const historyDir = path.join(root, 'history');
  fs.writeFileSync(tasksPath, JSON.stringify([{
    name: '收集新闻',
    cron: '35 4 * * *',
    room: 'GENERAL',
    enabled: true,
  }], null, 2), 'utf-8');

  const persistence = new TaskPersistence(tasksPath, historyDir);
  const tasks = persistence.loadTasks();

  assert.deepEqual(tasks, [{
    name: '收集新闻',
    prompt: '收集新闻',
    cron: '35 4 * * *',
    room: 'GENERAL',
    enabled: true,
  }]);

  fs.rmSync(root, { recursive: true, force: true });
});
