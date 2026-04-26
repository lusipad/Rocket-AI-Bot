import { z } from 'zod';

const toolTimeoutSchema = z.object({
  search_code: z.number().default(30),
  read_file: z.number().default(15),
  exec_codex: z.number().default(120),
  query_work_items: z.number().default(15),
  get_pr_status: z.number().default(10),
  get_pipeline_status: z.number().default(10),
});

const circuitBreakerSchema = z.object({
  failureThreshold: z.number().default(3),
  recoveryTimeout: z.number().default(10000),
});

const nativeWebSearchSchema = z.object({
  enabled: z.boolean().default(false),
  instruction: z.string().optional(),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  requestBody: z.record(z.string(), z.unknown()).default({}),
});

const repoConfigSchema = z.object({
  path: z.string(),
  name: z.string(),
  autoPull: z.boolean().default(false),
  pullInterval: z.number().default(3600),
});

const schedulerTaskSchema = z.object({
  name: z.string(),
  prompt: z.string().optional(),
  cron: z.string(),
  room: z.string(),
  enabled: z.boolean().default(true),
});

const rateLimitSchema = z.object({
  channelCooldownMs: z.number().default(5000),
  userMaxPerMinute: z.number().default(5),
});

export const configSchema = z.object({
  rocketchat: z.object({
    host: z.string().default('localhost'),
    useSsl: z.boolean().default(false),
    username: z.string(),
    password: z.string(),
    botUsername: z.string().default('RocketBot'),
  }),
  llm: z.object({
    endpoint: z.string(),
    apiKey: z.string(),
    model: z.string().default('gpt-4'),
    deepModel: z.string().optional(),
    apiMode: z.enum(['chat_completions', 'responses']).default('chat_completions'),
    contextWindow: z.number().default(128000),
    circuitBreaker: circuitBreakerSchema.default({}),
    nativeWebSearch: nativeWebSearchSchema.default({}),
    extraBody: z.record(z.string(), z.unknown()).default({}),
  }),
  azureDevOps: z.object({
    serverUrl: z.string().optional(),
    pat: z.string().optional(),
    project: z.string().optional(),
  }).optional(),
  azureDevOpsServer: z.object({
    collectionUrl: z.string().optional(),
    authMode: z.enum(['pat', 'default-credentials']).optional(),
    pat: z.string().optional(),
    project: z.string().optional(),
    team: z.string().optional(),
    apiVersion: z.string().optional(),
    serverVersionHint: z.enum(['2022', '2020', '2019', '2018', '2017', '2015', 'legacy']).optional(),
    searchBaseUrl: z.string().optional(),
    testResultsBaseUrl: z.string().optional(),
    scriptPath: z.string().optional(),
    powerShellPath: z.string().optional(),
  }).optional(),
  repos: z.array(repoConfigSchema).default([]),
  codex: z.object({
    path: z.string().optional(),
    workingDir: z.string().optional(),
    maxConcurrency: z.number().default(1),
    queueMaxSize: z.number().default(3),
  }).default({}),
  tools: z.object({
    timeout: toolTimeoutSchema.default({}),
  }).default({}),
  scheduler: z.object({
    persistencePath: z.string().default('data/scheduler/tasks.json'),
    tasks: z.array(schedulerTaskSchema).default([]),
  }).default({}),
  web: z.object({
    port: z.number().default(3001),
    secret: z.string().optional(),
    sessionExpiry: z.string().default('24h'),
  }).default({}),
  rateLimit: rateLimitSchema.default({}),
});

export type Config = z.infer<typeof configSchema>;
