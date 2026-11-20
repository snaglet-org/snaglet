/**
 * GET / PUT /api/threads/:id/notification-settings, the per-thread "notify me
 * when a run ends here" settings. GET on an unconfigured thread answers the
 * defaults (off, chime, both outcomes on) rather than 404; PUT saves and a
 * second PUT replaces in place; every field is required and strictly typed,
 * the sound from the shared list (400 otherwise); an unknown thread is 404 on
 * both verbs.
 */

import { beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { Threads } from '@snaglet/db';
import { ThreadNotificationSettingsTable } from '@snaglet/db/tables/thread_notification_settings';
import { errorHandler } from '@server/middleware';
import { registerThreadNotificationSettingsRoutes } from '@server/domains/threads/handlers/threadNotificationSettings';

const PREFIX = 'thread-notif-settings';
const THREAD = `thread-${PREFIX}-a`;
const FRESH_THREAD = `thread-${PREFIX}-b`;
const MISSING = `thread-${PREFIX}-nope`;

const url = (threadId: string) => `/api/threads/${threadId}/notification-settings`;

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerThreadNotificationSettingsRoutes(router);
  app.use('/api/threads', router);
  app.use(errorHandler);
  return app;
}

let app: express.Application;

beforeAll(async () => {
  await Threads.create({ id: THREAD, title: `${PREFIX} a` });
  await Threads.create({ id: FRESH_THREAD, title: `${PREFIX} b` });
  app = makeApp();
});

describe('GET /api/threads/:id/notification-settings', () => {
  it('answers the opt-in defaults for a thread that was never configured', async () => {
    const res = await request(app).get(url(FRESH_THREAD)).expect(200);
    expect(res.body.data.settings).toEqual({
      threadId: FRESH_THREAD,
      enabled: false,
      sound: 'chime',
      onCompleted: true,
      onFailed: true,
      updatedAt: null,
    });
    // Reading does not create a row.
    expect(await ThreadNotificationSettingsTable.get(FRESH_THREAD)).toBeNull();
  });

  it('is 404 for an unknown thread', async () => {
    await request(app).get(url(MISSING)).expect(404);
  });
});

describe('PUT /api/threads/:id/notification-settings', () => {
  it('saves the settings, then replaces them in place', async () => {
    const first = await request(app)
      .put(url(THREAD))
      .send({ enabled: true, sound: 'bell', onCompleted: true, onFailed: false })
      .expect(200);
    expect(first.body.data.settings).toMatchObject({
      threadId: THREAD,
      enabled: true,
      sound: 'bell',
      onCompleted: true,
      onFailed: false,
    });
    expect(first.body.data.settings.updatedAt).toEqual(expect.any(String));

    // Readable straight back.
    const read = await request(app).get(url(THREAD)).expect(200);
    expect(read.body.data.settings).toMatchObject({ enabled: true, sound: 'bell' });

    const second = await request(app)
      .put(url(THREAD))
      .send({ enabled: false, sound: 'none', onCompleted: false, onFailed: true })
      .expect(200);
    expect(second.body.data.settings).toMatchObject({
      enabled: false,
      sound: 'none',
      onCompleted: false,
      onFailed: true,
    });
  });

  it('is 404 for an unknown thread, before it validates the body', async () => {
    await request(app).put(url(MISSING)).send({ enabled: 'yes' }).expect(404);
  });

  it.each([
    ['an empty body', {}],
    ['a non-object body', []],
    ['a missing sound', { enabled: true, onCompleted: true, onFailed: true }],
    ['an unknown sound', { enabled: true, sound: 'airhorn', onCompleted: true, onFailed: true }],
    [
      'a non-boolean enabled',
      { enabled: 'yes', sound: 'chime', onCompleted: true, onFailed: true },
    ],
    ['a missing onCompleted', { enabled: true, sound: 'chime', onFailed: true }],
    ['a non-boolean onFailed', { enabled: true, sound: 'chime', onCompleted: true, onFailed: 1 }],
  ])('refuses %s with 400', async (_label, body) => {
    const res = await request(app).put(url(THREAD)).send(body).expect(400);
    expect(res.body.error).toBeTruthy();
  });
});
