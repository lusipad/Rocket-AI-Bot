import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/helpers.js';

export type ContextScope = 'direct' | 'group' | 'thread';
export type RoomType = 'c' | 'p' | 'd' | 'l';

export interface ContextScopePolicy {
  recentMessageCount: number;
  discussionRecentMessageCount: number;
  summaryEnabled: boolean;
}

export interface PublicChannelContextPolicy {
  lookbackMinutes: number;
  discussionLookbackMinutes: number;
}

export interface ContextPolicy {
  direct: ContextScopePolicy;
  group: ContextScopePolicy;
  thread: ContextScopePolicy;
  publicChannel: PublicChannelContextPolicy;
}

const DEFAULT_POLICY: ContextPolicy = {
  direct: {
    recentMessageCount: 40,
    discussionRecentMessageCount: 80,
    summaryEnabled: true,
  },
  group: {
    recentMessageCount: 40,
    discussionRecentMessageCount: 80,
    summaryEnabled: true,
  },
  thread: {
    recentMessageCount: 40,
    discussionRecentMessageCount: 80,
    summaryEnabled: true,
  },
  publicChannel: {
    lookbackMinutes: 45,
    discussionLookbackMinutes: 180,
  },
};

export class ContextPolicyStore {
  private readonly filePath: string;
  private policy: ContextPolicy;

  constructor(filePath = path.resolve(process.cwd(), 'data', 'context', 'policy.json')) {
    this.filePath = filePath;
    ensureDir(path.dirname(this.filePath));
    this.policy = this.load();
    this.save();
  }

  get(): ContextPolicy {
    return clonePolicy(this.policy);
  }

  set(input: Partial<ContextPolicy>): ContextPolicy {
    this.policy = normalizeContextPolicy(mergeContextPolicy(this.policy, input));
    this.save();
    return this.get();
  }

  private load(): ContextPolicy {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return normalizeContextPolicy(JSON.parse(raw) as Partial<ContextPolicy>);
    } catch {
      return clonePolicy(DEFAULT_POLICY);
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.policy, null, 2), 'utf8');
  }
}

export function getDefaultContextPolicy(): ContextPolicy {
  return clonePolicy(DEFAULT_POLICY);
}

export function normalizeContextPolicy(input: Partial<ContextPolicy> | undefined): ContextPolicy {
  return {
    direct: normalizeScopePolicy(input?.direct, DEFAULT_POLICY.direct),
    group: normalizeScopePolicy(input?.group, DEFAULT_POLICY.group),
    thread: normalizeScopePolicy(input?.thread, DEFAULT_POLICY.thread),
    publicChannel: normalizePublicChannelPolicy(input?.publicChannel, DEFAULT_POLICY.publicChannel),
  };
}

export function resolveContextScope(input: {
  roomType?: RoomType;
  threadId?: string;
}): ContextScope {
  if (input.threadId) {
    return 'thread';
  }

  return input.roomType === 'd' ? 'direct' : 'group';
}

export function resolveRecentMessageLimit(
  policy: ContextPolicy,
  scope: ContextScope,
  discussionRequest: boolean,
): number {
  const selected = policy[scope];
  return discussionRequest
    ? selected.discussionRecentMessageCount
    : selected.recentMessageCount;
}

export function resolvePublicChannelLookbackMs(
  policy: ContextPolicy,
  roomType: RoomType | undefined,
  discussionRequest: boolean,
): number | undefined {
  if (roomType !== 'c') {
    return undefined;
  }

  const minutes = discussionRequest
    ? policy.publicChannel.discussionLookbackMinutes
    : policy.publicChannel.lookbackMinutes;
  return minutes * 60 * 1000;
}

function normalizeScopePolicy(
  input: Partial<ContextScopePolicy> | undefined,
  fallback: ContextScopePolicy,
): ContextScopePolicy {
  return {
    recentMessageCount: clampInteger(input?.recentMessageCount, fallback.recentMessageCount, 1, 120),
    discussionRecentMessageCount: clampInteger(
      input?.discussionRecentMessageCount,
      fallback.discussionRecentMessageCount,
      1,
      120,
    ),
    summaryEnabled: typeof input?.summaryEnabled === 'boolean'
      ? input.summaryEnabled
      : fallback.summaryEnabled,
  };
}

function normalizePublicChannelPolicy(
  input: Partial<PublicChannelContextPolicy> | undefined,
  fallback: PublicChannelContextPolicy,
): PublicChannelContextPolicy {
  return {
    lookbackMinutes: clampInteger(input?.lookbackMinutes, fallback.lookbackMinutes, 5, 24 * 60),
    discussionLookbackMinutes: clampInteger(
      input?.discussionLookbackMinutes,
      fallback.discussionLookbackMinutes,
      5,
      24 * 60,
    ),
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function clonePolicy(policy: ContextPolicy): ContextPolicy {
  return JSON.parse(JSON.stringify(policy)) as ContextPolicy;
}

function mergeContextPolicy(
  current: ContextPolicy,
  patch: Partial<ContextPolicy> | undefined,
): ContextPolicy {
  if (!patch) {
    return clonePolicy(current);
  }

  return {
    direct: {
      ...current.direct,
      ...(patch.direct ?? {}),
    },
    group: {
      ...current.group,
      ...(patch.group ?? {}),
    },
    thread: {
      ...current.thread,
      ...(patch.thread ?? {}),
    },
    publicChannel: {
      ...current.publicChannel,
      ...(patch.publicChannel ?? {}),
    },
  };
}
