import { Router } from 'express';
import type { Scheduler } from '../../scheduler/index.js';
import type { Logger } from '../../utils/logger.js';

export function createTaskRoutes(scheduler: Scheduler, logger: Logger): Router {
  const router = Router();

  // GET /api/tasks
  router.get('/', (_req, res) => {
    const tasks = scheduler.listTasks();
    res.json(tasks);
  });

  // GET /api/tasks/history?name=xxx&limit=20
  router.get('/history', (req, res) => {
    const { name, limit } = req.query;
    const history = scheduler.getHistory(
      typeof name === 'string' ? name : undefined,
      typeof limit === 'string' ? parseInt(limit) : undefined,
    );
    res.json(history);
  });

  // POST /api/tasks
  router.post('/', (req, res) => {
    try {
      const { name, prompt, cron: cronExpr, room, enabled } = req.body;
      if (!name || !cronExpr) {
        return res.status(400).json({ error: 'name 和 cron 必填' });
      }
      scheduler.addTask({
        name,
        prompt: typeof prompt === 'string' && prompt.trim() ? prompt.trim() : name,
        cron: cronExpr,
        room: room ?? 'general',
        enabled: enabled ?? true,
      });
      logger.info('任务已创建', { name });
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // PUT /api/tasks/:name
  router.put('/:name', (req, res) => {
    const { name } = req.params;
    const { prompt, cron: cronExpr, room, enabled } = req.body;
    const existing = scheduler.listTasks().find(task => task.name === name);
    const nextTask = {
      name,
      prompt: typeof prompt === 'string'
        ? (prompt.trim() || existing?.prompt || name)
        : (existing?.prompt ?? name),
      cron: cronExpr ?? existing?.cron,
      room: room ?? existing?.room ?? 'general',
      enabled: enabled ?? existing?.enabled ?? true,
    };

    if (!nextTask.cron) {
      return res.status(400).json({ error: 'cron 必填' });
    }

    scheduler.addTask(nextTask);
    res.json({ ok: true });
  });

  // DELETE /api/tasks/:name
  router.delete('/:name', (req, res) => {
    scheduler.removeTask(req.params.name);
    res.json({ ok: true });
  });

  // POST /api/tasks/:name/run
  router.post('/:name/run', async (req, res) => {
    const result = await scheduler.runNow(req.params.name);
    res.json(result);
  });

  return router;
}
