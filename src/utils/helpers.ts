import path from 'node:path';
import fs from 'node:fs';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function isPathWithin(base: string, target: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function sanitizeError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.split('\n')[0];
}
