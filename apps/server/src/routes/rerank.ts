import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  AppError,
  ConflictError,
  asTrimmedString,
  clampInt,
  getErrorMessage,
} from '@snaglet/shared/utils';
import {
  getLocalRerankerStatus,
  rerank,
  type RerankCandidate,
} from '@server/services/reranking/LocalRerankerService';
import { isRerankerEnabled, RERANKER_OFF_MESSAGE } from '@server/services/reranking/rerankerFlag';

const router = Router();

const MAX_QUERY_CHARS = 8_000;
const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_CHARS = 40_000;

function parseCandidates(input: unknown): RerankCandidate[] {
  if (!Array.isArray(input)) {
    throw new AppError(
      'candidates must be an array',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (input.length === 0 || input.length > MAX_CANDIDATES) {
    throw new AppError(
      `candidates must contain 1-${MAX_CANDIDATES} items`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }

  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new AppError(
        `candidate ${index} must be an object`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const candidate = raw as Record<string, unknown>;
    const text = asTrimmedString(candidate.text);
    if (!text) {
      throw new AppError(
        `candidate ${index} text is required`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (text.length > MAX_CANDIDATE_CHARS) {
      throw new AppError(
        `candidate ${index} text exceeds ${MAX_CANDIDATE_CHARS} characters`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const metadata =
      candidate.metadata &&
      typeof candidate.metadata === 'object' &&
      !Array.isArray(candidate.metadata)
        ? (candidate.metadata as Record<string, unknown>)
        : undefined;

    return {
      id: asTrimmedString(candidate.id) || undefined,
      text,
      metadata,
    };
  });
}

// With the `reranker` flag off, status reports "off" without probing the
// model files, and scoring refuses before anything loads.
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    if (!(await isRerankerEnabled())) {
      sendOk(res, { enabled: false, ready: false, message: RERANKER_OFF_MESSAGE });
      return;
    }
    sendOk(res, { enabled: true, ...(await getLocalRerankerStatus()) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!(await isRerankerEnabled())) throw new ConflictError(RERANKER_OFF_MESSAGE);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = asTrimmedString(body.query);
    if (!query) {
      throw new AppError('query is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw new AppError(
        `query exceeds ${MAX_QUERY_CHARS} characters`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    try {
      const candidates = parseCandidates(body.candidates);
      const topK =
        body.topK == null
          ? undefined
          : clampInt(body.topK, candidates.length, 1, candidates.length);
      const maxSequenceTokens =
        body.maxSequenceTokens == null ? undefined : clampInt(body.maxSequenceTokens, 512, 32, 512);
      const batchSize = body.batchSize == null ? undefined : clampInt(body.batchSize, 8, 1, 32);

      const result = await rerank({
        query,
        candidates,
        providerId: asTrimmedString(body.providerId) || undefined,
        modelId: asTrimmedString(body.modelId) || undefined,
        topK,
        maxSequenceTokens,
        batchSize,
      });
      sendOk(res, result);
    } catch (err) {
      throw new AppError(getErrorMessage(err), ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
  })
);

export default router;
