import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { RequestLogStore, type RequestLogEntry } from '../src/observability/request-log-store.ts';
import { createAzureDevOpsServerRestTool } from '../src/tools/azure-devops-server-rest.ts';

type SkillSource = 'explicit' | 'model' | 'system';

interface RocketChatLoginResult {
  userId: string;
  authToken: string;
}

interface RocketChatRoom {
  _id: string;
  rid?: string;
}

interface SmokeUser {
  username: string;
  password: string;
  email: string;
  name: string;
}

interface ScenarioDefinition {
  name: string;
  roomId: string;
  text: string;
  requiredSkill: string;
  requiredSource: SkillSource;
  requiredTool?: string;
  adoWorkItemTitle?: string;
  optional?: boolean;
}

interface ScenarioResult {
  name: string;
  prompt: string;
  requestId: string;
  status: string;
  activeSkills: string[];
  skillSources: Record<string, SkillSource>;
  usedTools: string[];
  optional: boolean;
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
const BETWEEN_MESSAGES_DELAY_MS = 13_000;
const GROUP_READY_DELAY_MS = 2_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const requestLogStore = new RequestLogStore();
  const runId = buildRunId();
  const rocketChatBaseUrl = normalizeBaseUrl(config.rocketchat.host, config.rocketchat.useSsl);
  const azureDevOpsServerRestReady = isAzureDevOpsServerRestReady(config);
  const liveWriteSmokeEnabled = process.env.AZURE_DEVOPS_SERVER_LIVE_WRITE_SMOKE === '1';
  const liveWriteTitle = `RocketBot live write smoke ${runId}`;

  await assertBotHealth(`http://127.0.0.1:${config.web.port}`);

  const smokeLogin = await ensureSmokeUser(rocketChatBaseUrl, DEFAULT_SMOKE_USER);
  const botLogin = await login(rocketChatBaseUrl, config.rocketchat.username, config.rocketchat.password);

  let groupRoomId: string | null = null;
  let groupName: string | null = null;

  try {
    const createdGroup = await createPrivateGroup(
      rocketChatBaseUrl,
      smokeLogin,
      `smoke-${runId}`,
      botLogin.userId,
    );
    groupRoomId = createdGroup.roomId;
    groupName = createdGroup.roomName;
    await sleep(GROUP_READY_DELAY_MS);

    const dmRoomId = await ensureDirectRoom(
      rocketChatBaseUrl,
      smokeLogin,
      config.rocketchat.username,
    );

    const scenarios: ScenarioDefinition[] = [
      {
        name: 'group-code-lookup',
        roomId: groupRoomId,
        text: `@${config.rocketchat.botUsername} [smoke:${runId}:code] 请用 code-lookup 看下 src/index.ts 是做什么的，只用一句话。`,
        requiredSkill: 'code-lookup',
        requiredSource: 'explicit',
      },
      {
        name: 'dm-ado-lookup',
        roomId: dmRoomId,
        text: `[smoke:${runId}:ado] 请用 ado-lookup 查下当前 Azure DevOps 项目最近的活跃 PR；如果没有，也直接说明没有。`,
        requiredSkill: 'ado-lookup',
        requiredSource: 'explicit',
        requiredTool: 'azure_devops',
      },
      {
        name: 'dm-azure-devops-server-rest',
        roomId: dmRoomId,
        text: `[smoke:${runId}:ado-server] 请用 azure-devops-server 通过 azure_devops_server_rest dryRun 预览 GET projects 查询，只需要说明预览 URL。`,
        requiredSkill: 'azure-devops-server',
        requiredSource: 'explicit',
        requiredTool: 'azure_devops_server_rest',
        optional: !azureDevOpsServerRestReady,
      },
      {
        name: 'dm-pr-review',
        roomId: dmRoomId,
        text: `[smoke:${runId}:pr] 请用 pr-review 审查一下当前 Azure DevOps 项目最近一个 PR 的主要风险；如果没有 PR，就明确说无法审查。`,
        requiredSkill: 'pr-review',
        requiredSource: 'explicit',
        requiredTool: 'azure_devops',
      },
      {
        name: 'dm-artifact-writer-observe',
        roomId: dmRoomId,
        text: `[smoke:${runId}:artifact] 把下面零散信息整理成一段可直接发给团队的简短播报：1. 今天补了 skill 来源追踪；2. 管理页已经能看请求记录；3. 下一步是把真实环境 smoke 测试沉淀成脚本。`,
        requiredSkill: 'artifact-writer',
        requiredSource: 'model',
        optional: true,
      },
    ];

    if (liveWriteSmokeEnabled) {
      if (!azureDevOpsServerRestReady) {
        throw new Error('AZURE_DEVOPS_SERVER_LIVE_WRITE_SMOKE=1 但 Azure DevOps Server REST 配置不可用');
      }

      scenarios.splice(3, 0, {
        name: 'dm-azure-devops-server-live-write',
        roomId: dmRoomId,
        text:
          `[smoke:${runId}:ado-server-write] 请使用 $azure-devops-server 创建一个 Azure DevOps Server Task，标题必须是 "${liveWriteTitle}"。`
          + '要求先用 azure_devops_server_rest 对 PATCH wit/workitems/$Task 做 dryRun=true 预览，'
          + '然后用同样 payload 设置 allowWrite=true 和 jsonPatch=true 执行真实创建，最后回复创建出的 work item id。',
        requiredSkill: 'azure-devops-server',
        requiredSource: 'explicit',
        requiredTool: 'azure_devops_server_rest',
        adoWorkItemTitle: liveWriteTitle,
      });
    }

    const results: ScenarioResult[] = [];

    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      const startedAt = Date.now();

      console.log(`\n[smoke] 发送场景: ${scenario.name}`);
      await postMessage(rocketChatBaseUrl, smokeLogin, scenario.roomId, scenario.text);

      const entry = await waitForRequestLog(requestLogStore, DEFAULT_SMOKE_USER.username, scenario.text, startedAt);
      const result = evaluateScenario(scenario, entry);

      if (scenario.adoWorkItemTitle && result.passed) {
        try {
          await verifyAzureDevOpsServerWorkItemTitle(config, scenario.adoWorkItemTitle);
        } catch (error) {
          result.passed = false;
          result.note = appendNote(result.note, `ADO work item 回查失败: ${toErrorMessage(error)}`);
        }
      }

      results.push(result);

      console.log(formatScenarioResult(result));
      if (index < scenarios.length - 1) {
        await sleep(BETWEEN_MESSAGES_DELAY_MS);
      }
    }

    printSummary(runId, groupName ?? groupRoomId ?? '-', results);

    const requiredFailures = results.filter((item) => !item.optional && !item.passed);
    if (requiredFailures.length > 0) {
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

function isAzureDevOpsServerRestReady(config: ReturnType<typeof loadConfig>): boolean {
  const collectionUrl = config.azureDevOpsServer?.collectionUrl || config.azureDevOps?.serverUrl;
  const scriptPath = path.resolve(
    config.azureDevOpsServer?.scriptPath
    ?? path.join('.agents', 'skills', 'azure-devops-server', 'scripts', 'Invoke-AzureDevOpsServerApi.ps1'),
  );

  return Boolean(collectionUrl && fs.existsSync(scriptPath));
}

async function verifyAzureDevOpsServerWorkItemTitle(
  config: ReturnType<typeof loadConfig>,
  title: string,
): Promise<void> {
  const collectionUrl = config.azureDevOpsServer?.collectionUrl || config.azureDevOps?.serverUrl;
  if (!collectionUrl) {
    throw new Error('缺少 Azure DevOps Server collection URL');
  }

  const scriptPath = path.resolve(
    config.azureDevOpsServer?.scriptPath
    ?? path.join('.agents', 'skills', 'azure-devops-server', 'scripts', 'Invoke-AzureDevOpsServerApi.ps1'),
  );
  const tool = createAzureDevOpsServerRestTool({
    collectionUrl,
    authMode: config.azureDevOpsServer?.authMode ?? (config.azureDevOpsServer?.pat || config.azureDevOps?.pat ? 'pat' : 'default-credentials'),
    pat: config.azureDevOpsServer?.pat ?? config.azureDevOps?.pat,
    project: config.azureDevOpsServer?.project ?? config.azureDevOps?.project,
    team: config.azureDevOpsServer?.team,
    apiVersion: config.azureDevOpsServer?.apiVersion,
    serverVersionHint: config.azureDevOpsServer?.serverVersionHint,
    searchBaseUrl: config.azureDevOpsServer?.searchBaseUrl,
    testResultsBaseUrl: config.azureDevOpsServer?.testResultsBaseUrl,
    scriptPath,
    powerShellPath: config.azureDevOpsServer?.powerShellPath,
  });

  const queryTitle = title.replace(/'/g, "''");
  const result = await tool.execute(
    {
      method: 'POST',
      area: 'wit',
      project: config.azureDevOpsServer?.project ?? config.azureDevOps?.project,
      resource: 'wiql',
      body: {
        query:
          "Select [System.Id], [System.Title], [System.State] From WorkItems "
          + `Where [System.TeamProject] = '${config.azureDevOpsServer?.project ?? config.azureDevOps?.project ?? 'test'}' `
          + `And [System.Title] = '${queryTitle}'`,
      },
    },
    createNoopLogger() as never,
  );

  if (!result.success) {
    throw new Error(String(result.data.error ?? 'WIQL 查询失败'));
  }

  const payload = result.data.result;
  const workItems = isRecord(payload) && Array.isArray(payload.workItems) ? payload.workItems : [];
  if (workItems.length === 0) {
    throw new Error(`未查到标题为 "${title}" 的工作项`);
  }
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  } catch (error) {
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

async function ensureDirectRoom(
  baseUrl: string,
  loginResult: RocketChatLoginResult,
  username: string,
): Promise<string> {
  const response = await fetchJson<{ room?: RocketChatRoom }>(`${baseUrl}/api/v1/im.create`, {
    method: 'POST',
    headers: authHeaders(loginResult),
    body: JSON.stringify({ username }),
  });

  const roomId = response.room?.rid ?? response.room?._id;
  if (!roomId) {
    throw new Error('创建 smoke 私聊失败');
  }

  return roomId;
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
    console.warn(`[smoke] 清理私有群失败: ${toErrorMessage(error)}`);
  }
}

async function waitForRequestLog(
  store: RequestLogStore,
  username: string,
  prompt: string,
  startedAt: number,
): Promise<RequestLogEntry> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const entry = store
      .list({ username, limit: 50 })
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

  if (!entry.activeSkills.includes(scenario.requiredSkill)) {
    notes.push(`缺少 skill=${scenario.requiredSkill}`);
  }

  const actualSource = entry.skillSources[scenario.requiredSkill];
  if (actualSource !== scenario.requiredSource) {
    notes.push(`skill 来源不符，期望=${scenario.requiredSource}，实际=${actualSource ?? 'none'}`);
  }

  if (scenario.requiredTool && !entry.usedTools.includes(scenario.requiredTool)) {
    notes.push(`缺少工具=${scenario.requiredTool}`);
  }

  if (!scenario.optional && entry.status !== 'success') {
    notes.push(`请求状态=${entry.status}`);
  }

  return {
    name: scenario.name,
    prompt: entry.prompt,
    requestId: entry.requestId,
    status: entry.status,
    activeSkills: entry.activeSkills,
    skillSources: entry.skillSources,
    usedTools: entry.usedTools,
    optional: Boolean(scenario.optional),
    passed: notes.length === 0,
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
}

function printSummary(runId: string, groupName: string, results: ScenarioResult[]): void {
  console.log(`\n[smoke] runId=${runId}`);
  console.log(`[smoke] 临时群=${groupName}`);
  console.log('[smoke] 结果汇总:');

  for (const result of results) {
    const level = result.optional ? 'OPTIONAL' : 'REQUIRED';
    const status = result.passed ? 'PASS' : 'FAIL';
    const skills = result.activeSkills.length > 0 ? result.activeSkills.join(', ') : '-';
    const tools = result.usedTools.length > 0 ? result.usedTools.join(', ') : '-';
    const note = result.note ? ` | ${result.note}` : '';
    console.log(`- [${level}/${status}] ${result.name} | skills=${skills} | tools=${tools}${note}`);
  }
}

function formatScenarioResult(result: ScenarioResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const note = result.note ? ` | ${result.note}` : '';
  return `[smoke] ${status} ${result.name} | requestId=${result.requestId} | status=${result.status} | skills=${result.activeSkills.join(', ') || '-'} | tools=${result.usedTools.join(', ') || '-'}${note}`;
}

function appendNote(existing: string | undefined, addition: string): string {
  return existing ? `${existing}；${addition}` : addition;
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
  console.error(`[smoke] 失败: ${toErrorMessage(error)}`);
  process.exitCode = 1;
});
