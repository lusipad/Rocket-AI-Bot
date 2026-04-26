import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './helpers.js';

export interface ProcessLock {
  acquired: boolean;
  holderPid?: number;
  release: () => void;
}

export function acquireProcessLock(lockFilePath: string, pid = process.pid): ProcessLock {
  ensureDir(path.dirname(lockFilePath));

  return tryAcquire(lockFilePath, pid, false);
}

function tryAcquire(lockFilePath: string, pid: number, retried: boolean): ProcessLock {
  try {
    const handle = fs.openSync(lockFilePath, 'wx');
    fs.writeFileSync(handle, `${pid}\n`, 'utf8');
    fs.closeSync(handle);

    return {
      acquired: true,
      release: () => releaseProcessLock(lockFilePath, pid),
    };
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }

    const holderPid = readLockPid(lockFilePath);
    if (holderPid !== undefined && isProcessAlive(holderPid)) {
      return {
        acquired: false,
        holderPid,
        release: () => {},
      };
    }

    if (retried) {
      throw error;
    }

    try {
      fs.unlinkSync(lockFilePath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkError;
      }
    }

    return tryAcquire(lockFilePath, pid, true);
  }
}

function releaseProcessLock(lockFilePath: string, pid: number): void {
  const holderPid = readLockPid(lockFilePath);
  if (holderPid !== pid) {
    return;
  }

  try {
    fs.unlinkSync(lockFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function readLockPid(lockFilePath: string): number | undefined {
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    if (!raw) {
      return undefined;
    }

    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }

    return code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
