/**
 * Bind every supertest server to 127.0.0.1, never dual-stack `::`.
 *
 * Stock supertest (7.x) does `app.listen(0)` for an app that is not already
 * listening. With no host, Node binds `::` (dual-stack), and supertest then
 * sends the request to the hard-coded `http://127.0.0.1:<port>`. On macOS a
 * different process can still bind 127.0.0.1 on that same port, and when it
 * does, that process answers our request. Other suites' servers, Snaglet.app and
 * editor helpers are all candidates. Symptoms were cross-suite flakes where the
 * "wrong" server answered: threadTrim 404 for 409, routes/tools 403 for 200,
 * sidecarAuth 403 for 401.
 *
 * Binding 127.0.0.1 explicitly makes the port ours: a second 127.0.0.1 bind
 * fails with EADDRINUSE. `listen(0, host)` is asynchronous (it does a lookup),
 * so the request is held until the listen callback fires. Servers that are
 * already listening are left alone, as stock supertest does.
 *
 * Guarded by tests/unit/apps/server/support/supertestLoopback.test.ts. If
 * supertest changes the shape of `serverAddress`/`end`, this file throws at
 * setup instead of silently doing nothing; re-check the patch against the new
 * version before updating `assertShape`.
 */
'use strict';

const tls = require('node:tls');
const { Test } = require('supertest');
const supertestVersion = require('supertest/package.json').version;

const PATCHED = Symbol.for('snaglet.supertestLoopback');

function assertShape() {
  const source = Test.prototype.serverAddress.toString();
  const endSource = Test.prototype.end.toString();
  const ok =
    /^7\./.test(supertestVersion) &&
    source.includes('app.listen(0)') &&
    source.includes("'://127.0.0.1:'") &&
    endSource.includes('this._server');
  if (!ok) {
    throw new Error(
      `tests/support/supertestLoopback.cjs: supertest ${supertestVersion} no longer matches ` +
        'the serverAddress/end shape this patch replaces. Re-verify the loopback patch ' +
        'against the new version before updating this check.'
    );
  }
}

if (!Test.prototype[PATCHED]) {
  assertShape();
  const originalEnd = Test.prototype.end;

  Test.prototype.serverAddress = function serverAddress(app, path) {
    const protocol = app instanceof tls.Server ? 'https' : 'http';
    const existing = app.address();
    if (existing) return `${protocol}://127.0.0.1:${existing.port}${path}`;

    this._server = app;
    this._loopbackListening = new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      app.once('error', onError);
      app.listen(0, '127.0.0.1', () => {
        app.removeListener('error', onError);
        this.url = `${protocol}://127.0.0.1:${app.address().port}${path}`;
        resolve();
      });
    });
    // Placeholder until listening; end() waits for the real URL.
    return `${protocol}://127.0.0.1:0${path}`;
  };

  Test.prototype.end = function end(fn) {
    const listening = this._loopbackListening;
    if (!listening) return originalEnd.call(this, fn);
    this._loopbackListening = null;
    // Block bodies on purpose: end() returns the Test, which is a thenable;
    // returning it here would make the promise adopt it, calling .then() and
    // so sending the request a second time.
    listening.then(
      () => {
        originalEnd.call(this, fn);
      },
      (error) => {
        if (typeof fn === 'function') fn(error);
      }
    );
    return this;
  };

  Object.defineProperty(Test.prototype, PATCHED, { value: true });
}
