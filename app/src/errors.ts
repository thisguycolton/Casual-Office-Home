export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}
export const notFound = () => new AppError(404, 'not_found', 'Not found');
export const badRequest = (code: string, msg?: string) => new AppError(400, code, msg);
