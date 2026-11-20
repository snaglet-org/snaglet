/**
 * Guard: integration:server loads tests/support/supertestLoopback.cjs.
 * The full behavior guard lives in
 * tests/unit/apps/server/support/supertestLoopback.test.ts; this file only
 * proves the integration project binds supertest servers to 127.0.0.1, so
 * dropping the setupFile from this project fails here.
 */
import { describe, expect, it } from '@jest/globals';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

function tryForeignBind(port: number, host: string): Promise<string> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERROR'));
    probe.listen(port, host, () => probe.close(() => resolve('BOUND')));
  });
}

describe('supertest loopback setupFile (integration:server)', () => {
  it('binds supertest servers to 127.0.0.1 exclusively', async () => {
    let address: AddressInfo | undefined;
    let foreign = 'not-run';
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = http.createServer((_req, res) => {
      void held.then(() => res.end('ours'));
    });

    const response = request(app)
      .get('/probe')
      .then((res) => res.text);
    try {
      while (!app.listening) await new Promise((resolve) => setImmediate(resolve));
      address = app.address() as AddressInfo;
      foreign = await tryForeignBind(address.port, '127.0.0.1');
    } finally {
      release();
    }

    expect({ host: address?.address, foreign }).toEqual({
      host: '127.0.0.1',
      foreign: 'EADDRINUSE',
    });
    expect(await response).toBe('ours');
  });
});
