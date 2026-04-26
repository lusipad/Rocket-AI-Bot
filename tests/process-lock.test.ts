import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireProcessLock } from '../src/utils/process-lock.ts';

function createLockPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-lock-')),
    'rocketbot.lock',
  );
}

test('acquireProcessLock 应阻止同一路径重复启动', () => {
  const lockPath = createLockPath();

  const first = acquireProcessLock(lockPath);
  const second = acquireProcessLock(lockPath);

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.holderPid, process.pid);

  first.release();

  const third = acquireProcessLock(lockPath);
  assert.equal(third.acquired, true);
  third.release();
});

test('acquireProcessLock 应接管陈旧锁文件', () => {
  const lockPath = createLockPath();
  fs.writeFileSync(lockPath, '99999999\n', 'utf8');

  const lock = acquireProcessLock(lockPath);

  assert.equal(lock.acquired, true);
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));

  lock.release();
});
