export class AppError extends Error {
  constructor(
    readonly status: number,
    override readonly message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, message, code, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, message, 'UNAUTHORIZED');

export const forbidden = (message: string, code = 'FORBIDDEN') => new AppError(403, message, code);

export const notFound = (message = 'Not found') => new AppError(404, message, 'NOT_FOUND');

export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, message, code, details);
