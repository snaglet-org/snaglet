/**
 * The SPA catch-all mount in apps/server/src/index.ts. The server runs
 * Express 4, where an Express-5-style `/{*splat}` pattern matches nothing, so
 * browser deep links and hard refreshes would 404 in packaged builds. The
 * handler is mounted under the Express 4 catch-all `'*'`; its body
 * (file-extension / `Accept` checks + `next()`) decides whether to serve the
 * shell.
 *
 * Resolution note: as in apiCatchAll.test.ts, express is resolved from a real
 * apps/server/src file, because the repo-root hoisted Express 5 would make
 * `{*splat}` appear to work.
 */
import request from 'supertest';
import type express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

// See the file-level comment: resolve express relative to a real
// apps/server/src module (not this test file) to get the server's actual
// pinned express@4.22.1 install instead of the repo-root hoisted 5.2.1.
const expressLib: typeof express = require(
  require.resolve('express', { paths: [require.resolve('@server/routes/api')] })
);

// Verbatim copy of the handler body mounted at apps/server/src/index.ts
// (the "Only serve the SPA shell for browser navigations..." block). What is
// under test is the mount pattern, not this logic.
function mountSpaShellHandler(app: express.Application, webStaticPath: string, pattern: string) {
  app.get(pattern, (req, res, next) => {
    const hasFileExtension = path.extname(req.path) !== '';
    const prefersHtml = req.accepts('html');

    if (hasFileExtension || !prefersHtml) {
      return next();
    }

    res.sendFile(path.join(webStaticPath, 'index.html'));
  });
}

describe('SPA catch-all shell handler (mirrors apps/server/src/index.ts mount order)', () => {
  let webStaticPath: string;
  let app: express.Application;

  beforeAll(() => {
    webStaticPath = fs.mkdtempSync(path.join(os.tmpdir(), 'snaglet-spa-catchall-test-'));
    fs.writeFileSync(path.join(webStaticPath, 'index.html'), '<!doctype html><title>shell</title>');
    fs.writeFileSync(path.join(webStaticPath, 'app.js'), 'console.log("asset");');

    app = expressLib();
    // Real static serving first, exactly like index.ts.
    app.use(expressLib.static(webStaticPath));
    // The bare Express 4 catch-all `'*'` matches every path without
    // grouped-wildcard syntax.
    mountSpaShellHandler(app, webStaticPath, '*');
    // Fall-through 404 so a missed match is observable as "no shell served".
    app.use((req, res) => res.status(404).send('no match'));
  });

  afterAll(() => {
    fs.rmSync(webStaticPath, { recursive: true, force: true });
  });

  it('serves the index.html shell for a deep-link browser navigation', async () => {
    const res = await request(app).get('/some/deep/route').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<title>shell</title>');
  });

  it('does not serve the shell for an asset request (has a file extension) — falls through to static/404', async () => {
    // Not present at webStaticPath under a different name, so express.static
    // misses and falls through to the catch-all, which must still decline
    // (hasFileExtension) and hand off to the final 404 handler.
    const res = await request(app).get('/missing-asset.js').set('Accept', 'text/html');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>shell</title>');
  });

  it('does not serve the shell for a non-HTML Accept header — falls through to 404', async () => {
    const res = await request(app).get('/some/deep/route').set('Accept', 'application/json');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>shell</title>');
  });

  it('still serves real static assets normally (matched assets are unaffected)', async () => {
    const res = await request(app).get('/app.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log');
  });
});
