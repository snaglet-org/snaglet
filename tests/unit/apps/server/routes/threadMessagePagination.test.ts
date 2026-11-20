import express from 'express';
import request from 'supertest';

const mockFindThread = jest.fn();
const mockFindMessage = jest.fn();
const mockListMessages = jest.fn();
const mockContext = jest.fn();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { findById: (...args: unknown[]) => mockFindThread(...args) },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    findById: (...args: unknown[]) => mockFindMessage(...args),
    listForThreadRead: (...args: unknown[]) => mockListMessages(...args),
    getContextWindow: (...args: unknown[]) => mockContext(...args),
    hasOlderThan: jest.fn().mockResolvedValue(false),
    hasNewerThan: jest.fn().mockResolvedValue(false),
  },
}));
import { registerMessageRoutes } from '@server/domains/threads/handlers/messageHandlers';
import { errorHandler } from '@server/middleware/errorHandler';

describe('thread message cursor paging', () => {
  const app = express();
  const router = express.Router();
  registerMessageRoutes(router);
  app.use('/threads', router);
  app.use(errorHandler);
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindThread.mockResolvedValue({ id: 'thread-test' });
    mockListMessages.mockResolvedValue([]);
  });
  it('uses the anchor id instead of a timestamp-only boundary', async () => {
    mockFindMessage.mockResolvedValue({
      id: 'message-test',
      threadId: 'thread-test',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const response = await request(app).get(
      '/threads/thread-test/messages?before=message-test&limit=200'
    );
    expect(response.status).toBe(200);
    expect(mockListMessages).toHaveBeenCalledWith('thread-test', {
      limit: 200,
      beforeId: 'message-test',
    });
  });
  it('does not page a cursor belonging to a different thread', async () => {
    mockFindMessage.mockResolvedValue({ id: 'message-test', threadId: 'thread-other' });
    const response = await request(app).get('/threads/thread-test/messages?before=message-test');
    expect(response.status).toBe(404);
    expect(mockListMessages).not.toHaveBeenCalled();
  });
  it('does not inject a different conversation into an around window', async () => {
    mockContext.mockResolvedValue({
      anchor: { id: 'message-test', threadId: 'thread-other' },
      messages: [{ id: 'message-test', content: 'Other thread' }],
    });
    const response = await request(app).get('/threads/thread-test/messages?around=message-test');
    expect(response.status).toBe(200);
    expect(response.body.data.messages).toEqual([]);
  });
});
