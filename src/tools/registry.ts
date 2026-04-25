import crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { ToolDef } from '../llm/client.js';
import { sanitizeError } from '../utils/helpers.js';

export interface ToolResult {
  success: boolean;
  data: Record<string, unknown>;
}

export interface Tool {
  /** LLM 看到的工具定义 */
  definition: ToolDef;
  /** 执行工具 */
  execute(params: Record<string, unknown>, logger: Logger): Promise<ToolResult>;
  /** 超时时间(ms) */
  timeout: number;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  register(tool: Tool): void {
    const name = tool.definition.function.name;
    this.tools.set(name, tool);
    this.logger.info('工具已注册', { name, timeout: tool.timeout });
  }

  getDefinitions(): ToolDef[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, data: { error: `未知工具: ${name}` } };
    }

    const requestId = crypto.randomUUID();
    this.logger.info('执行工具', { requestId, tool: name, params });

    try {
      const result = await withTimeout(tool.execute(params, this.logger), tool.timeout);
      result.data.requestId = requestId;
      return result;
    } catch (err) {
      this.logger.error('工具执行失败', { requestId, tool: name, error: String(err) });
      return {
        success: false,
        data: { requestId, error: sanitizeError(err) },
      };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`执行超时 (${ms}ms)`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
