import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebServer } from '../src/web/server.ts';
import { Scheduler } from '../src/scheduler/index.ts';
import { TaskPersistence } from '../src/scheduler/persistence.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createScheduler(root: string) {
  const persistence = new TaskPersistence(
    path.join(root, 'tasks.json'),
    path.join(root, 'history'),
  );

  return new Scheduler(
    persistence,
    async (task) => ({ success: true, output: `ran:${task.name}` }),
    createLogger() as never,
  );
}

async function withServer<T>(
  scheduler: Scheduler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = createWebServer({
    logger: createLogger() as never,
    scheduler,
    llm: {
      circuitBreaker: { stateName: 'CLOSED' },
      getModel: () => 'gpt-4',
    } as never,
    bot: {
      isConnected: false,
    } as never,
    webSecret: 'secret-token',
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('无法获取监听端口');
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    scheduler.stopAll();
  }
}

test('健康检查接口不应要求鉴权', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);

  await withServer(scheduler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, 'ok');
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test('任务局部更新时应保留已有 cron 和 room', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-web-'));
  const scheduler = createScheduler(root);
  scheduler.addTask({
    name: 'daily-report',
    cron: '0 9 * * 1-5',
    room: 'general',
    enabled: true,
  });

  await withServer(scheduler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/daily-report`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(scheduler.listTasks(), [{
    name: 'daily-report',
    cron: '0 9 * * 1-5',
    room: 'general',
    enabled: false,
  }]);

  fs.rmSync(root, { recursive: true, force: true });
});
