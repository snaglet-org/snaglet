/**
 * Guard for tests/support/supertestLoopback.cjs.
 *
 * Stock supertest binds an unlistened app on dual-stack `::` but requests
 * 127.0.0.1, so a foreign 127.0.0.1 listener on the same port can answer.
 * The setupFile makes every supertest server bind 127.0.0.1, which a second
 * 127.0.0.1 bind cannot share. These cases fail if the setupFile is dropped
 * from the jest project or stops patching (e.g. after a supertest upgrade).
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

describe('supertest loopback setupFile', () => {
  it('binds an unlistened app to 127.0.0.1 and a foreign 127.0.0.1 bind on that port is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = http.createServer((_req, res) => {
      void gate.then(() => res.end('ours'));
    });

    const response = request(app)
      .get('/probe')
      .expect(200)
      .then((res) => res.text);
    let address: AddressInfo;
    let foreign: string;
    try {
      // Wait until supertest's server is listening, then try to steal its port.
      while (!app.listening) await new Promise((resolve) => setImmediate(resolve));
      address = app.address() as AddressInfo;
      foreign = await tryForeignBind(address.port, '127.0.0.1');
    } finally {
      release(); // never leave the server holding a request open
    }
    const text = await response.catch((error: Error) => `request failed: ${error.message}`);

    expect({ host: address.address, foreign }).toEqual({
      host: '127.0.0.1',
      foreign: 'EADDRINUSE',
    });
    expect(text).toBe('ours');
    expect(app.listening).toBe(false); // supertest still closes its own server
  });

  it('keeps the stock supertest call shapes working', async () => {
    const app = (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end(`${req.method} ${req.url}`);
    };

    expect((await request(app).get('/a?b=1').expect(200)).text).toBe('GET /a?b=1');

    const viaEnd = await new Promise<string>((resolve, reject) => {
      request(app)
        .post('/cb')
        .send({ a: 1 })
        .expect(200)
        .end((error, res) => (error ? reject(error) : resolve(res.text)));
    });
    expect(viaEnd).toBe('POST /cb');

    await expect(request(app).get('/missing').expect(200)).rejects.toThrow(
      'expected 200 "OK", got 404 "Not Found"'
    );

    // Each awaited request reaches the server exactly once.
    let hits = 0;
    const counting = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      hits += 1;
      res.statusCode = 404;
      res.end();
    };
    await expect(request(counting).get('/once').expect(200)).rejects.toThrow('got 404');
    expect(hits).toBe(1);

    const agent = request.agent(app);
    expect((await agent.get('/one')).text).toBe('GET /one');
    expect((await agent.get('/two')).text).toBe('GET /two');
  });

  it('leaves an already-listening server alone', async () => {
    const server = http.createServer((_req, res) => res.end('pre-bound'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect((await request(server).get('/')).text).toBe('pre-bound');
      expect((server.address() as AddressInfo).port).toBe(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
