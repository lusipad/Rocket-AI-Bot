import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Tool, ToolResult } from './registry.js';
import type { Logger } from '../utils/logger.js';

const EXCLUDED_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next',
  'venv', '__pycache__', '.cache', 'target', 'coverage',
];

const EXCLUDED_FILES = [
  '*.pem', 'id_rsa*', 'id_dsa*', 'credentials*', 'secrets*', '*.key', '*.cert',
];

const MAX_RESULTS = 50;
const LINES_PER_MATCH = 3;

export function createRepoSearchTool(repoRoots: { path: string; name: string }[]): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'search_code',
        description:
          '在本地代码仓库中搜索代码。使用 ripgrep 进行高速搜索。' +
          '当用户询问代码实现、函数位置、类型定义时使用。不适用于常识性问题。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词或正则表达式' },
            repo: { type: 'string', description: `可选: ${repoRoots.map(r => r.name).join(', ')}` },
            file_pattern: { type: 'string', description: '可选: 文件类型过滤，如 "*.ts" 或 "*.py"' },
          },
          required: ['query'],
        },
      },
    },
    timeout: 30000,

    async execute(params: Record<string, unknown>, _logger: Logger): Promise<ToolResult> {
      const query = String(params.query ?? '');
      const repoName = params.repo ? String(params.repo) : null;
      const filePattern = params.file_pattern ? String(params.file_pattern) : null;

      if (!query.trim()) {
        return { success: false, data: { error: '搜索关键词不能为空' } };
      }

      // 确定搜索目录
      let searchDirs = repoRoots;
      if (repoName) {
        const found = repoRoots.find(r => r.name === repoName);
        searchDirs = found ? [found] : searchDirs;
      }

      const allResults: string[] = [];
      for (const repo of searchDirs) {
        try {
          const rgs = buildRgArgs(query, filePattern);
          rgs.push(repo.path);
          const result = await execRg(rgs);
          if (result) {
            allResults.push(`--- ${repo.name} (${repo.path}) ---`);
            allResults.push(result);
          }
        } catch {
          // 跳过无法搜索的目录
        }
      }

      if (allResults.length === 0) {
        return { success: true, data: { matches: [], summary: '未找到匹配的代码' } };
      }

      const output = allResults.join('\n').slice(0, 20000); // 限制输出
      return {
        success: true,
        data: {
          matches: ['(见下方输出)'],
          summary: `找到匹配结果`,
          output,
        },
      };
    },
  };
}

function buildRgArgs(query: string, filePattern: string | null): string[] {
  const args = ['-n', '--no-heading', `-C${LINES_PER_MATCH}`, query];

  // 排除目录
  for (const dir of EXCLUDED_DIRS) {
    args.push('-g', `!*/${dir}/*`);
    args.push('-g', `!${dir}/**`);
  }

  // 排除敏感文件
  for (const file of EXCLUDED_FILES) {
    args.push('-g', `!${file}`);
  }

  // 文件类型过滤
  if (filePattern) {
    args.push('-g', filePattern);
  }

  args.push('-m', String(MAX_RESULTS));
  return args;
}

function execRg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('rg', args, { maxBuffer: 10 * 1024 * 1024, timeout: 28000 }, (err, stdout) => {
      if (err) {
        // exit code 1 = no matches, not really an error
        if (err.code === 1 && !stdout) return resolve('');
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
