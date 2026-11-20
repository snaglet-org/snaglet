import morgan from 'morgan';
import { httpLogStream } from '../config/logger';

/**
 * HTTP request logging middleware using morgan + winston.
 *
 * Logs: method, URL, status code, content-length, response time
 *
 * Format: ':method :url :status :res[content-length] - :response-time ms'
 */
export const requestLogger = morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  { stream: httpLogStream }
);
