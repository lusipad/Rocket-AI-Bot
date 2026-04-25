import winston from 'winston';
import 'winston-daily-rotate-file';

const { combine, timestamp: ts, printf, colorize } = winston.format;

const logFormat = printf(({ timestamp, level, message, requestId, module, ...meta }) => {
  const rid = requestId ? ` [${requestId}]` : '';
  const mod = module ? ` ${module}` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp}${rid} ${level}${mod}: ${message}${metaStr}`;
});

export function createLogger(logDir: string = 'data/logs') {
  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    format: combine(ts({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
    transports: [
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: 'rocketbot-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '30d',
        zippedArchive: true,
      }),
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: 'error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        maxSize: '20m',
        maxFiles: '90d',
        zippedArchive: true,
      }),
      new winston.transports.Console({
        format: combine(colorize(), logFormat),
      }),
    ],
  });
}

export type Logger = ReturnType<typeof createLogger>;
