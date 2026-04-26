import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Router } from 'express';
import type { SkillRegistry } from '../../skills/registry.js';
import { isPathWithin } from '../../utils/helpers.js';
import type { Logger } from '../../utils/logger.js';

export function createSkillRoutes(skillRegistry: SkillRegistry, logger: Logger): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(skillRegistry.listInstalled());
  });

  router.post('/install', (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const subdir = typeof req.body?.subdir === 'string' ? req.body.subdir.trim() : '';

    if (!source) {
      return res.status(400).json({ error: 'source 不能为空' });
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skill-install-'));

    try {
      const clonedDir = path.join(tempDir, 'repo');
      const cloneResult = spawnSync('git', ['clone', '--depth', '1', source, clonedDir], {
        encoding: 'utf8',
        timeout: 60_000,
      });

      if (cloneResult.error || cloneResult.status !== 0) {
        return res.status(400).json({
          error: `git clone 失败: ${extractGitError(cloneResult.error?.message, cloneResult.stderr, cloneResult.stdout)}`,
        });
      }

      const skillDir = resolveSkillDirectory(clonedDir, subdir);
      const installed = skillRegistry.installFromDirectory(skillDir);
      const skills = skillRegistry.listInstalled();
      logger.info('skill 已安装', {
        name: installed.name,
        source,
        subdir: subdir || undefined,
        installed: skills.length,
      });

      res.status(201).json({
        ok: true,
        installed,
        skills,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  router.post('/reload', (_req, res) => {
    const skills = skillRegistry.reload();
    logger.info('skills 已重新扫描', {
      installed: skills.length,
      enabled: skills.filter((skill) => skill.enabled).length,
    });
    res.json({
      ok: true,
      skills,
    });
  });

  router.get('/:name', (req, res) => {
    const skill = skillRegistry.getInstalled(req.params.name);
    if (!skill) {
      return res.status(404).json({ error: `未找到 skill: ${req.params.name}` });
    }

    res.json(skill);
  });

  router.put('/:name', (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled 必须为布尔值' });
      }

      const updated = skillRegistry.setEnabled(req.params.name, enabled);
      logger.info('skill 启用状态已更新', {
        name: updated.name,
        enabled: updated.enabled,
      });
      res.json(updated);
    } catch (error) {
      res.status(404).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.delete('/:name', (req, res) => {
    try {
      const skills = skillRegistry.remove(req.params.name);
      logger.info('skill 已卸载', {
        name: req.params.name,
        installed: skills.length,
      });
      res.json({
        ok: true,
        skills,
      });
    } catch (error) {
      res.status(404).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}

function resolveSkillDirectory(repoDir: string, subdir: string): string {
  if (subdir) {
    const targetDir = path.resolve(repoDir, subdir);
    if (!isPathWithin(repoDir, targetDir)) {
      throw new Error(`subdir 超出仓库范围: ${subdir}`);
    }
    if (!fs.existsSync(path.join(targetDir, 'SKILL.md'))) {
      throw new Error(`指定目录未找到 SKILL.md: ${subdir}`);
    }
    return targetDir;
  }

  const candidates = findSkillDirectories(repoDir);
  if (candidates.length === 0) {
    throw new Error('仓库中未找到任何 SKILL.md');
  }
  if (candidates.length > 1) {
    const relativePaths = candidates.map((candidate) => path.relative(repoDir, candidate) || '.');
    throw new Error(`仓库中找到多个 skill，请指定 subdir: ${relativePaths.join(', ')}`);
  }
  return candidates[0];
}

function findSkillDirectories(rootDir: string): string[] {
  const result: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) {
      continue;
    }

    if (fs.existsSync(path.join(currentDir, 'SKILL.md'))) {
      result.push(currentDir);
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      queue.push(path.join(currentDir, entry.name));
    }
  }

  return result.sort((a, b) => a.localeCompare(b));
}

function extractGitError(errorMessage: string | undefined, stderr: string, stdout: string): string {
  const message = errorMessage?.trim() || stderr.trim() || stdout.trim() || '未知错误';
  return message.split(/\r?\n/)[0];
}
