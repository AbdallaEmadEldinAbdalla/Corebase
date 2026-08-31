import type { FastifyInstance } from 'fastify';
import { ERROR_CODES, type ErrorCode } from '@corebase/types';

/** Thrown by modules; the kernel renders it into the D-032 envelope. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  static notFound(what: string) {
    return new ApiError(404, ERROR_CODES.PROJECT_NOT_FOUND, `${what} does not exist.`);
  }
  static validation(message: string) {
    return new ApiError(400, ERROR_CODES.VALIDATION_FAILED, message);
  }
  static unauthorized() {
    return new ApiError(401, ERROR_CODES.UNAUTHORIZED, 'Missing or invalid credentials.');
  }
}

/**
 * One error shape for the whole surface, and X-Request-ID on every response —
 * including errors, which is the case that actually matters for support (D-032).
 * Internal messages are never leaked to the client (proposal §105).
 */
export function registerErrorHandling(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : req.id;
    reply.header('x-request-id', id);
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);
    if (err instanceof ApiError) {
      req.log.info({ code: err.code, statusCode: err.statusCode }, 'request rejected');
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, request_id: requestId },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: ERROR_CODES.INTERNAL,
        message: 'Something went wrong on our side. Quote the request id if you contact support.',
        request_id: requestId,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);
    return reply.status(404).send({
      error: { code: ERROR_CODES.PROJECT_NOT_FOUND, message: 'No such route.', request_id: requestId },
    });
  });
}
