import { loadConfig } from '../src/config/index.ts';
import { RequestLogStore, type RequestLogEntry } from '../src/observability/request-log-store.ts';

interface RocketChatLoginResult {
  userId: string;
  authToken: string;
}

interface RocketChatRoom {
  _id: string;
}

interface SmokeUser {
  username: string;
  password: string;
  email: string;
  name: string;
}

interface ScenarioDefinition {
  name: string;
  text: string;
  expectReplyIncludes?: string[];
  expectFinishReason?: string;
  expectModel?: string;
  expectModelMode?: 'normal' | 'deep';
}

interface ScenarioResult {
  name: string;
  requestId: string;
  status: string;
  finishReason?: string;
  model: string;
  modelMode?: string;
  passed: boolean;
  note?: string;
}

const DEFAULT_SMOKE_USER: SmokeUser = {
  username: process.env.SMOKE_RC_USERNAME?.trim() || 'rocketbot_smoke',
  password: process.env.SMOKE_RC_PASSWORD?.trim() || 'RocketBotSmoke!2026',
  email: process.env.SMOKE_RC_EMAIL?.trim() || 'rocketbot_smoke@example.com',
  name: process.env.SMOKE_RC_NAME?.trim() || 'RocketBot Smoke',
};

const REQUEST_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
const BETWEEN_MESSAGES_DELAY_MS = 6_000;
const GROUP_READY_DELAY_MS = 2_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const requestLogStore = new RequestLogStore();
  const runId = buildRunId();
  const rocketChatBaseUrl = normalizeBaseUrl(config.rocketchat.host, config.rocketchat.useSsl);

  await assertBotHealth(`http://127.0.0.1:${config.web.port}`);

  const smokeLogin = await ensureSmokeUser(rocketChatBaseUrl, DEFAULT_SMOKE_USER);
  const botLogin = await login(rocketChatBaseUrl, config.rocketchat.username, config.rocketchat.password);

  let groupRoomId: string | null = null;
  let groupName: string | null = null;

  try {
    const createdGroup = await createPrivateGroup(
      rocketChatBaseUrl,
      smokeLogin,
      `smoke-cmd-${runId}`,
      botLogin.userId,
    );
    groupRoomId = createdGroup.roomId;
    groupName = createdGroup.roomName;
    await sleep(GROUP_READY_DELAY_MS);

    const mention = `@${config.rocketchat.botUsername}`;
    const normalModel = config.llm.model;
    const deepModel = config.llm.deepModel?.trim();
    if (!deepModel) {
      throw new Error('未配置 LLM_DEEP_MODEL，无法测试深度模式');
    }

    const scenarios: ScenarioDefinition[] = [
      {
        name: 'help-command',
        text: `${mention} |help`,
        expectFinishReason: 'command_help',
        expectReplyIncludes: ['可用指令', '|deep', '|normal', '|skills'],
        expectModelMode: 'normal',
      },
      {
        name: 'status-normal-command',
        text: `${mention} |status`,
        expectFinishReason: 'command_status',
        expectReplyIncludes: ['当前状态', '普通模式', normalModel],
        expectModelMode: 'normal',
      },
      {
        name: 'skills-command',
        text: `${mention} |skills`,
        expectFinishReason: 'skill_help',
        expectReplyIncludes: ['当前已启用的 skills', 'code-lookup'],
        expectModelMode: 'normal',
      },
      {
        name: 'context-reset-command',
        text: `${mention} |context reset`,
        expectFinishReason: 'context_reset',
        expectReplyIncludes: ['当前房间', '缓存摘要'],
        expectModelMode: 'normal',
      },
      {
        name: 'natural-deep-words-stay-normal',
        text: `${mention} [smoke:${runId}:natural] 请深入分析这个复杂问题，只回复 natural-normal-ok`,
        expectFinishReason: 'reply',
        expectReplyIncludes: ['natural-normal-ok'],
        expectModel: normalModel,
        expectModelMode: 'normal',
      },
      {
        name: 'enter-deep-command',
        text: `${mention} |deep`,
        expectFinishReason: 'enter_deep_mode',
        expectReplyIncludes: ['已进入深度模式', deepModel, '|normal'],
        expectModel: deepModel,
        expectModelMode: 'deep',
      },
      {
        name: 'status-deep-command',
        text: `${mention} |status`,
        expectFinishReason: 'command_status',
        expectReplyIncludes: ['当前状态', '深度模式', deepModel],
        expectModel: deepModel,
        expectModelMode: 'deep',
      },
      {
        name: 'deep-message-uses-deep-model',
        text: `${mention} [smoke:${runId}:deep] 普通问题，只回复 explicit-deep-ok`,
        expectFinishReason: 'reply',
        expectReplyIncludes: ['explicit-deep-ok'],
        expectModel: deepModel,
        expectModelMode: 'deep',
      },
      {
        name: 'exit-deep-command',
        text: `${mention} |normal`,
        expectFinishReason: 'exit_deep_mode',
        expectReplyIncludes: ['已退出深度模式', normalModel],
        expectModel: normalModel,
        expectModelMode: 'normal',
      },
      {
        name: 'status-normal-after-command',
        text: `${mention} |status`,
        expectFinishReason: 'command_status',
        expectReplyIncludes: ['当前状态', '普通模式', normalModel],
        expectModelMode: 'normal',
      },
      {
        name: 'normal-message-after-exit',
        text: `${mention} [smoke:${runId}:normal-after] 只回复 normal-after-deep-ok`,
        expectFinishReason: 'reply',
        expectReplyIncludes: ['normal-after-deep-ok'],
        expectModel: normalModel,
        expectModelMode: 'normal',
      },
    ];

    const results: ScenarioResult[] = [];

    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      const startedAt = Date.now();

      console.log(`\n[smoke:commands] 发送场景: ${scenario.name}`);
      await postMessage(rocketChatBaseUrl, smokeLogin, groupRoomId, scenario.text);

      const entry = await waitForRequestLog(
        requestLogStore,
        DEFAULT_SMOKE_USER.username,
        groupRoomId,
        scenario.text,
        startedAt,
      );
      const result = evaluateScenario(scenario, entry);
      results.push(result);

      console.log(formatScenarioResult(result));
      if (index < scenarios.length - 1) {
        await sleep(BETWEEN_MESSAGES_DELAY_MS);
      }
    }

    printSummary(runId, groupName ?? groupRoomId, results);

    if (results.some((item) => !item.passed)) {
      process.exitCode = 1;
    }
  } finally {
    if (groupRoomId) {
      await deletePrivateGroup(rocketChatBaseUrl, smokeLogin, groupRoomId);
    }
  }
}

function buildRunId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(2, 14);
}

async function assertBotHealth(webBaseUrl: string): Promise<void> {
  const response = await fetchJson<{ status: string; connections?: { rocketchat?: string; llm?: string } }>(
    `${webBaseUrl}/api/health`,
  );

  if (response.status !== 'ok') {
    throw new Error(`Bot 健康检查失败: ${response.status}`);
  }

  if (response.connections?.rocketchat !== 'connected') {
    throw new Error('Bot 当前没有连接到 Rocket.Chat，请先启动并确认连接成功。');
  }
}

async function ensureSmokeUser(baseUrl: string, user: SmokeUser): Promise<RocketChatLoginResult> {
  try {
    return await login(baseUrl, user.username, user.password);
  } catch {
    await registerUser(baseUrl, user);
    return login(baseUrl, user.username, user.password);
  }
}

async function login(baseUrl: string, username: string, password: string): Promise<RocketChatLoginResult> {
  const response = await fetchJson<{
    status: string;
    data?: { userId?: string; authToken?: string };
  }>(`${baseUrl}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: username, password }),
  });

  if (response.status !== 'success' || !response.data?.userId || !response.data?.authToken) {
    throw new Error(`Rocket.Chat 登录失败: ${username}`);
  }

  return {
    userId: response.data.userId,
    authToken: response.data.authToken,
  };
}

async function registerUser(baseUrl: string, user: SmokeUser): Promise<void> {
  await fetchJson(`${baseUrl}/api/v1/users.register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: user.username,
      email: user.email,
      pass: user.password,
      name: user.name,
    }),
  });
}

async function createPrivateGroup(
  baseUrl: string,
  loginResult: RocketChatLoginResult,
  roomName: string,
  botUserId: string,
): Promise<{ roomId: string; roomName: string }> {
  const created = await fetchJson<{ group?: RocketChatRoom }>(`${baseUrl}/api/v1/groups.create`, {
    method: 'POST',
    headers: authHeaders(loginResult),
    body: JSON.stringify({ name: roomName }),
  });

  const roomId = created.group?._id;
  if (!roomId) {
    throw new Error('创建 smoke 私有群失败');
  }

  await fetchJson(`${baseUrl}/api/v1/groups.invite`, {
    method: 'POST',
    headers: authHeaders(loginResult),
    body: JSON.stringify({ roomId, userId: botUserId }),
  });

  return { roomId, roomName };
}

async function postMessage(
  baseUrl: string,
  loginResult: RocketChatLoginResult,
  roomId: string,
  text: string,
): Promise<void> {
  await fetchJson(`${baseUrl}/api/v1/chat.postMessage`, {
    method: 'POST',
    headers: authHeaders(loginResult),
    body: JSON.stringify({ roomId, text }),
  });
}

async function deletePrivateGroup(
  baseUrl: string,
  loginResult: RocketChatLoginResult,
  roomId: string,
): Promise<void> {
  try {
    await fetchJson(`${baseUrl}/api/v1/groups.delete`, {
      method: 'POST',
      headers: authHeaders(loginResult),
      body: JSON.stringify({ roomId }),
    });
  } catch (error) {
    console.warn(`[smoke:commands] 清理私有群失败: ${toErrorMessage(error)}`);
  }
}

async function waitForRequestLog(
  store: RequestLogStore,
  username: string,
  roomId: string,
  prompt: string,
  startedAt: number,
): Promise<RequestLogEntry> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const entry = store
      .list({ username, roomId, limit: 100 })
      .find((item) =>
        item.prompt === prompt
        && Date.parse(item.startedAt) >= startedAt - 1_000,
      );

    if (entry) {
      return entry;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`等待请求日志超时: ${prompt}`);
}

function evaluateScenario(scenario: ScenarioDefinition, entry: RequestLogEntry): ScenarioResult {
  const notes: string[] = [];
  const reply = entry.reply ?? '';
  const modelMode = entry.context?.modelMode;

  if (entry.status !== 'success') {
    notes.push(`请求状态=${entry.status}`);
  }

  if (scenario.expectFinishReason && entry.finishReason !== scenario.expectFinishReason) {
    notes.push(`finishReason 期望=${scenario.expectFinishReason}，实际=${entry.finishReason ?? 'none'}`);
  }

  for (const expectedText of scenario.expectReplyIncludes ?? []) {
    if (!reply.includes(expectedText)) {
      notes.push(`回复缺少 "${expectedText}"`);
    }
  }

  if (scenario.expectModel && entry.model !== scenario.expectModel) {
    notes.push(`模型期望=${scenario.expectModel}，实际=${entry.model}`);
  }

  if (scenario.expectModelMode && modelMode !== scenario.expectModelMode) {
    notes.push(`模式期望=${scenario.expectModelMode}，实际=${modelMode ?? 'none'}`);
  }

  return {
    name: scenario.name,
    requestId: entry.requestId,
    status: entry.status,
    finishReason: entry.finishReason,
    model: entry.model,
    modelMode,
    passed: notes.length === 0,
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
}

function printSummary(runId: string, groupName: string, results: ScenarioResult[]): void {
  console.log(`\n[smoke:commands] runId=${runId}`);
  console.log(`[smoke:commands] 临时群=${groupName}`);
  console.log('[smoke:commands] 结果汇总:');

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const note = result.note ? ` | ${result.note}` : '';
    console.log(
      `- [${status}] ${result.name} | model=${result.model} | mode=${result.modelMode ?? '-'} | finish=${result.finishReason ?? '-'}${note}`,
    );
  }
}

function formatScenarioResult(result: ScenarioResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const note = result.note ? ` | ${result.note}` : '';
  return `[smoke:commands] ${status} ${result.name} | requestId=${result.requestId} | model=${result.model} | mode=${result.modelMode ?? '-'} | finish=${result.finishReason ?? '-'}${note}`;
}

function authHeaders(loginResult: RocketChatLoginResult): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': loginResult.authToken,
    'X-User-Id': loginResult.userId,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };

  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return data;
}

function normalizeBaseUrl(host: string, useSsl: boolean): string {
  const trimmed = host.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${useSsl ? 'https' : 'http'}://${trimmed}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`[smoke:commands] 失败: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
