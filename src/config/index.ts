import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { configSchema, type Config } from './schema.js';

dotenv.config();

function resolveEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
}

function loadYamlConfig(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parse(raw) ?? {};
  } catch {
    return {};
  }
}

/** 对 YAML 中的字符串值做类型转换，因为 ${} 占位符替换后都是字符串 */
function coerce(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = coerce(value as Record<string, unknown>);
    } else if (value === 'true' || value === 'false') {
      result[key] = value === 'true';
    } else if (typeof value === 'string' && /^\d+$/.test(value) &&
      (key === 'port' || key === 'contextWindow' || key === 'failureThreshold' ||
       key === 'recoveryTimeout' || key === 'maxConcurrency' || key === 'queueMaxSize' ||
       key === 'pullInterval' || key === 'channelCooldownMs' || key === 'userMaxPerMinute')) {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(configPath?: string): Config {
  const yamlPath = configPath ?? path.resolve('config', 'default.yaml');
  const yamlConfig = loadYamlConfig(yamlPath);

  // Resolve env vars
  const resolved = JSON.parse(
    JSON.stringify(yamlConfig),
    (_key: string, value: unknown) =>
      typeof value === 'string' ? resolveEnv(value) : value,
  );

  // Coerce types after env var substitution
  const coerced = coerce(resolved) as Record<string, any>;

  const merged = {
    rocketchat: {
      host: process.env.RC_HOST,
      useSsl: process.env.RC_USE_SSL === 'true' || coerced.rocketchat?.useSsl || false,
      username: process.env.RC_USERNAME,
      password: process.env.RC_PASSWORD,
      ...(coerced.rocketchat ?? {}),
    },
    llm: {
      endpoint: process.env.LLM_ENDPOINT,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
      deepModel: process.env.LLM_DEEP_MODEL,
      ...(coerced.llm ?? {}),
      apiMode: process.env.LLM_API_MODE || coerced.llm?.apiMode,
    },
    azureDevOps: {
      serverUrl: process.env.AZURE_DEVOPS_URL,
      pat: process.env.AZURE_DEVOPS_PAT,
      project: process.env.AZURE_DEVOPS_PROJECT,
      ...(coerced.azureDevOps ?? {}),
    },
    web: {
      port: Number(process.env.WEB_PORT) || 3001,
      secret: process.env.WEB_SECRET,
      ...(coerced.web ?? {}),
    },
    ...coerced,
  };

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    console.error('配置校验失败:', JSON.stringify(parsed.error.flatten(), null, 2));
    process.exit(1);
  }

  return parsed.data;
}
