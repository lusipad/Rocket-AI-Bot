import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/helpers.js';

export interface DiscussionSummaryScope {
  roomId: string;
  threadId?: string;
  roomType?: 'c' | 'p' | 'd' | 'l';
}

export interface DiscussionSummaryEntry extends DiscussionSummaryScope {
  summary: string;
  updatedAt: string;
  latestMessageAt?: string;
  sourceMessageCount: number;
}

export class DiscussionSummaryStore {
  private rootDir: string;

  constructor(rootDir = 'data/memory/discussion-summaries') {
    this.rootDir = rootDir;
    ensureDir(this.rootDir);
  }

  get(scope: DiscussionSummaryScope): DiscussionSummaryEntry | null {
    const filePath = this.getFilePath(scope);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DiscussionSummaryEntry;
    } catch {
      return null;
    }
  }

  save(entry: DiscussionSummaryEntry): void {
    const normalized = normalizeEntry(entry);
    fs.writeFileSync(
      this.getFilePath(normalized),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );
  }

  delete(scope: DiscussionSummaryScope): boolean {
    const filePath = this.getFilePath(scope);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.rmSync(filePath, { force: true });
    return true;
  }

  list(limit = 200): DiscussionSummaryEntry[] {
    const files = fs.readdirSync(this.rootDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .reverse();

    const entries: DiscussionSummaryEntry[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.rootDir, file), 'utf8')) as DiscussionSummaryEntry;
        entries.push(normalizeEntry(parsed));
      } catch {
        continue;
      }

      if (entries.length >= limit) {
        break;
      }
    }

    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private getFilePath(scope: DiscussionSummaryScope): string {
    const roomPart = `room-${sanitizeSegment(scope.roomId)}`;
    const threadPart = scope.threadId
      ? `thread-${sanitizeSegment(scope.threadId)}`
      : 'thread-root';
    return path.join(this.rootDir, `${roomPart}__${threadPart}.json`);
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeEntry(entry: DiscussionSummaryEntry): DiscussionSummaryEntry {
  return {
    roomId: entry.roomId,
    threadId: entry.threadId,
    roomType: entry.roomType,
    summary: entry.summary.trim(),
    updatedAt: entry.updatedAt,
    latestMessageAt: entry.latestMessageAt,
    sourceMessageCount: Math.max(0, Math.round(entry.sourceMessageCount)),
  };
}
