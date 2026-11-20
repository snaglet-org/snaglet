import { Router, Request, Response } from 'express';
import {
  getBrowserController,
  ProfileError,
  assertProfileId,
} from '@server/services/BrowserController';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

const router = Router();

function send(res: Response, err: unknown) {
  if (err instanceof ProfileError) {
    res.status(err.status).json({ ok: false, error: getErrorMessage(err) });
    return;
  }
  logger.error('[browser] route failed', { error: err });
  res.status(500).json({ ok: false, error: getErrorMessage(err) });
}

router.get('/profiles', async (_req: Request, res: Response) => {
  try {
    res.json(await getBrowserController().list());
  } catch (err) {
    send(res, err);
  }
});

router.post('/profiles', async (req: Request, res: Response) => {
  try {
    const { name } = (req.body ?? {}) as { name?: unknown };
    res.status(201).json(await getBrowserController().create(String(name ?? '')));
  } catch (err) {
    send(res, err);
  }
});

/** Opens the profile headed so the USER can sign in by hand. No agent involved. */
router.post('/profiles/:id/open', async (req: Request, res: Response) => {
  try {
    const c = getBrowserController();
    const id = assertProfileId(req.params.id);
    if (!(await c.list()).some((p) => p.id === id)) {
      throw new ProfileError(`unknown profile "${id}"`, 404);
    }
    await c.openForUser(id);
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
});

router.delete('/profiles/:id', async (req: Request, res: Response) => {
  try {
    await getBrowserController().remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    send(res, err);
  }
});

export default router;
