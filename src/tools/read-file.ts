import fs from 'node:fs';
import path from 'node:path';
import type { Tool, ToolResult } from './registry.js';
import type { Logger } from '../utils/logger.js';
import { isPathWithin } from '../utils/helpers.js';
import { createFileSource } from './source.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export function createReadFileTool(repoRoots: { path: string; name: string }[]): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'read_file',
        description:
          '读取仓库中指定文件的内容。当需要查看完整文件时使用，通常配合 search_code 先找到文件再读取。',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '相对于仓库根目录的文件路径' },
            repo: { type: 'string', description: `可选: ${repoRoots.map(r => r.name).join(', ')}` },
            lines: { type: 'string', description: '可选: 行号范围，如 "10-50"' },
          },
          required: ['file_path'],
        },
      },
    },
    timeout: 15000,

    async execute(params: Record<string, unknown>, _logger: Logger): Promise<ToolResult> {
      const filePath = String(params.file_path ?? '');
      const repoName = params.repo ? String(params.repo) : undefined;
      const lines = params.lines ? String(params.lines) : undefined;

      if (!filePath) {
        return { success: false, data: { error: 'file_path 不能为空' } };
      }

      // 选择仓库
      let root = repoRoots[0];
      if (repoName) {
        const found = repoRoots.find(r => r.name === repoName);
        if (found) root = found;
      }

      // 路径安全校验
      const fullPath = path.resolve(root.path, filePath);
      if (!isPathWithin(root.path, fullPath)) {
        return { success: false, data: { error: '路径超出仓库范围' } };
      }

      // 文件存在性
      if (!fs.existsSync(fullPath)) {
        return { success: false, data: { error: `文件不存在: ${filePath}` } };
      }

      // 大小限制
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) {
        return { success: false, data: { error: `文件过大 (${Math.round(stat.size / 1024)}KB)` } };
      }

      try {
        let content = fs.readFileSync(fullPath, 'utf-8');
        const totalLines = content.split('\n').length;
        let sourceStartLine: number | undefined;
        let sourceEndLine: number | undefined;

        // 行范围过滤
        if (lines) {
          const [start, end] = lines.split('-').map(Number);
          const allLines = content.split('\n');
          const s = Math.max(1, start ?? 1) - 1;
          const e = Math.min(allLines.length, end ?? allLines.length);
          content = allLines.slice(s, e).join('\n');
          sourceStartLine = s + 1;
          sourceEndLine = e;
        }

        const relativePath = path.relative(root.path, fullPath).replace(/\\/g, '/');
        return {
          success: true,
          data: {
            content: content.slice(0, 20000),
            totalLines,
            fileName: path.basename(fullPath),
            truncated: content.length > 20000,
            sources: [createFileSource(relativePath, sourceStartLine, sourceEndLine)],
          },
        };
      } catch {
        return { success: false, data: { error: '读取文件失败' } };
      }
    },
  };
}
