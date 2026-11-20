/**
 * Models routes — pins the DELETE provenance contract: a user-initiated
 * removal goes through Models.deactivateByUser (which stamps
 * metadata.deactivatedBy = 'user') and never the plain deactivate, so
 * reconciliation passes can tell user-removed rows from auto-deactivated ones
 * and do not resurrect them.
 */
import request from 'supertest';
import express from 'express';

const mockDeactivate = jest.fn();
const mockDeactivateByUser = jest.fn();
const mockProviderTypeOf = jest.fn();

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    deactivate: (...args: unknown[]) => mockDeactivate(...args),
    deactivateByUser: (...args: unknown[]) => mockDeactivateByUser(...args),
    providerTypeOf: (...args: unknown[]) => mockProviderTypeOf(...args),
  },
}));

// The router also imports discovery + entitlement modules; stub them so the
// suite never pulls in provider chains or a database.
jest.mock('@server/services/ProviderModelDiscoveryService', () => ({
  discoverModels: jest.fn(),
}));
jest.mock('@server/services/ProviderModelDiscoveryService/entitlements', () => ({
  isEntitlementReconcilable: jest.fn(),
  reconcileCopilotEntitlements: jest.fn(),
  reconcileEntitlements: jest.fn(),
}));
const mockEmitModelsChanged = jest.fn();
jest.mock('@server/realtime/surfaces/models', () => ({
  emitModelsChanged: (...args: unknown[]) => mockEmitModelsChanged(...args),
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import modelsRouter from '@server/routes/models';

interface RouteError {
  statusCode?: number;
  httpStatus?: number;
  code?: string;
  message?: string;
}

describe('Models routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/models', modelsRouter);
    app.use(
      (
        err: RouteError,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res
          .status(err.statusCode || err.httpStatus || 500)
          .json({ error: { code: err.code, message: err.message } });
      }
    );
  });

  beforeEach(() => jest.clearAllMocks());

  describe('DELETE /api/models/:id', () => {
    it('stamps user provenance via deactivateByUser (never plain deactivate)', async () => {
      mockProviderTypeOf.mockResolvedValue('llm');
      mockDeactivateByUser.mockResolvedValue('anthropic');

      const res = await request(app).delete('/api/models/row-123');

      expect(res.status).toBe(200);
      expect(mockDeactivateByUser).toHaveBeenCalledWith('row-123');
      expect(mockDeactivate).not.toHaveBeenCalled();
      // Open model pickers re-read the provider's list.
      expect(mockEmitModelsChanged).toHaveBeenCalledWith('anthropic');
    });

    it('404s when the model does not exist', async () => {
      mockProviderTypeOf.mockResolvedValue(null);
      mockDeactivateByUser.mockResolvedValue(null);

      const res = await request(app).delete('/api/models/missing');

      expect(res.status).toBe(404);
      expect(mockEmitModelsChanged).not.toHaveBeenCalled();
    });

    it('refuses to remove Snaglet-managed runtime models', async () => {
      mockProviderTypeOf.mockResolvedValue('runtime');

      const res = await request(app).delete('/api/models/builtin-embedder');

      expect(res.status).toBe(403);
      expect(mockDeactivateByUser).not.toHaveBeenCalled();
      expect(mockDeactivate).not.toHaveBeenCalled();
    });
  });
});
