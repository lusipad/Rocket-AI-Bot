import { Router } from 'express';
import type { DiscussionSummaryAdminService } from '../../discussion/admin-service.js';
import type { Logger } from '../../utils/logger.js';

export function createContextRoutes(
  adminService: DiscussionSummaryAdminService,
  logger: Logger,
): Router {
  const router = Router();

  router.get('/policy', (_req, res) => {
    res.json(adminService.getPolicy());
  });

  router.put('/policy', (req, res) => {
    res.json(adminService.setPolicy(req.body ?? {}));
  });

  router.get('/summaries', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    res.json(adminService.list(limit));
  });

  router.post('/summaries/clear', (req, res) => {
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : '';
    const threadId = typeof req.body?.threadId === 'string' ? req.body.threadId.trim() : undefined;

    if (!roomId) {
      return res.status(400).json({ error: 'roomId 不能为空' });
    }

    res.json({
      ok: true,
      deleted: adminService.clear({ roomId, threadId }),
    });
  });

  router.post('/summaries/rebuild', async (req, res) => {
    const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : '';
    const threadId = typeof req.body?.threadId === 'string' ? req.body.threadId.trim() : undefined;
    const roomType = req.body?.roomType === 'c'
      || req.body?.roomType === 'p'
      || req.body?.roomType === 'd'
      || req.body?.roomType === 'l'
      ? req.body.roomType
      : undefined;

    if (!roomId) {
      return res.status(400).json({ error: 'roomId 不能为空' });
    }

    try {
      const result = await adminService.rebuild({ roomId, threadId, roomType });
      res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      logger.warn('重建讨论摘要失败', { roomId, threadId, error: String(error) });
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  logger.info('上下文治理接口已注册');
  return router;
}
