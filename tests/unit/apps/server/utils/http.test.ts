import type { Response } from 'express';
import { sendCreated, sendFailure, sendOk, sendOkEmpty } from '@server/utils/http';

describe('server http response helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-30T12:34:56.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sendOk returns the standard success envelope', () => {
    const json = jest.fn();
    const res = { json } as unknown as Response;
    const data = { id: '1', name: 'Patty' };

    sendOk(res, data);

    expect(json).toHaveBeenCalledWith({
      success: true,
      data,
      timestamp: '2026-04-30T12:34:56.000Z',
    });
  });

  it('sendCreated sets 201 and returns the standard success envelope', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status } as unknown as Response;
    const data = { id: '2' };

    sendCreated(res, data);

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({
      success: true,
      data,
      timestamp: '2026-04-30T12:34:56.000Z',
    });
  });

  it('sendOkEmpty omits the data field for ack-style responses', () => {
    const json = jest.fn();
    const res = { json } as unknown as Response;

    sendOkEmpty(res);

    expect(json).toHaveBeenCalledWith({
      success: true,
      timestamp: '2026-04-30T12:34:56.000Z',
    });
  });

  it('sendFailure defaults to 400 and includes details only when provided', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status } as unknown as Response;

    sendFailure(res, 'Bad input');

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: 'Bad input',
      timestamp: '2026-04-30T12:34:56.000Z',
    });

    sendFailure(res, 'Missing thing', { status: 404, details: { id: 'x' } });

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenLastCalledWith({
      success: false,
      error: 'Missing thing',
      details: { id: 'x' },
      timestamp: '2026-04-30T12:34:56.000Z',
    });
  });
});
