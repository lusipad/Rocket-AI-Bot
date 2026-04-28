import { Router } from 'express';
import type { Logger } from '../../utils/logger.js';
import { RequestLogStore } from '../../observability/request-log-store.js';
import { isAgentRequestType } from '../../agent-core/classification.js';

export function createRequestRoutes(store: RequestLogStore, logger: Logger): Router {
  const router = Router();

  router.get('/summary/recent', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    res.json(store.summarizeRecent(limit));
  });

  router.get('/metrics/devtools', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    res.json(store.summarizeDevTools(limit));
  });

  router.get('/', (req, res) => {
    const { kind, status, username, roomId, taskName, limit } = req.query;
    const requestType = typeof req.query.requestType === 'string' && isAgentRequestType(req.query.requestType)
      ? req.query.requestType
      : undefined;
    const entries = store.list({
      kind: typeof kind === 'string' && (kind === 'chat' || kind === 'scheduler') ? kind : undefined,
      status: typeof status === 'string' && (status === 'success' || status === 'error' || status === 'rejected')
        ? status
        : undefined,
      requestType,
      username: typeof username === 'string' ? username : undefined,
      roomId: typeof roomId === 'string' ? roomId : undefined,
      taskName: typeof taskName === 'string' ? taskName : undefined,
      limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
    });
    res.json(entries);
  });

  router.get('/:requestId', (req, res) => {
    const entry = store.get(req.params.requestId);
    if (!entry) {
      return res.status(404).json({ error: '请求记录不存在' });
    }

    res.json(entry);
  });

  logger.info('请求记录接口已注册');
  return router;
}
