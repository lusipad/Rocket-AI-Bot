import { exec, execFile } from 'node:child_process';
import pLimit from 'p-limit';
import type { Tool, ToolResult } from './registry.js';
import type { Logger } from '../utils/logger.js';

export function createCodexTool(codexPath: string, workingDir: string, maxConcurrency = 1): Tool {
  const limit = pLimit(maxConcurrency);

  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'exec_codex',
        description:
          '调用 Codex CLI 执行编程任务。Codex CLI 是本地代码智能工具，' +
          '能理解完整的代码库上下文，生成、重构、分析代码。' +
          '当用户需要生成代码、重构、跨文件分析、运行测试等复杂任务时使用。' +
          '不适合简单搜索（用 search_code）或纯对话问答。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '要传递给 Codex CLI 的任务描述' },
            working_dir: { type: 'string', description: `可选: 工作目录，默认 ${workingDir}` },
            skill: { type: 'string', description: '可选: 要使用的 Codex 技能名称' },
          },
          required: ['prompt'],
        },
      },
    },
    timeout: 120000,

    async execute(params: Record<string, unknown>, logger: Logger): Promise<ToolResult> {
      const prompt = String(params.prompt ?? '');
      const wd = params.working_dir ? String(params.working_dir) : workingDir;
      const skill = params.skill ? String(params.skill) : null;

      if (!prompt.trim()) {
        return { success: false, data: { error: 'task prompt 不能为空' } };
      }

      return limit(async () => {
        try {
          const cmd = buildCodexCommand(codexPath, prompt, skill);
          const result = await execCmd(cmd, wd, 110000);
          return {
            success: true,
            data: {
              output: result.slice(0, 30000),
              truncated: result.length > 30000,
            },
          };
        } catch (err) {
          // 队列满或 Codex 失败
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('Codex 执行失败', { error: msg });
          return { success: false, data: { error: msg } };
        }
      });
    },
  };
}

function buildCodexCommand(codexPath: string, prompt: string, skill?: string | null): string {
  const safe = prompt.replace(/"/g, '\\"');
  const skillFlag = skill ? ` --skill "${skill}"` : '';
  return `"${codexPath}" exec "${safe}"${skillFlag}`;
}

function execCmd(command: string, cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (stdout) resolve(stdout.trim()); // Codex 有时返回非零退出码但有输出
        else reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
