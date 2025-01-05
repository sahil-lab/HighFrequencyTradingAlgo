// logger.js - Enhanced Logging Utility with Winston and FS-based Fallback

const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

/**
 * Basic FS-based Logger (Fallback)
 * Writes logs to 'fallback.log' with timestamp.
 */
const fallbackLogPath = path.join(__dirname, 'logs', 'fallback.log');

// Ensure the logs directory exists
fs.mkdirSync(path.dirname(fallbackLogPath), { recursive: true });

const fallbackLogStream = fs.createWriteStream(fallbackLogPath, { flags: 'a' });

function fallbackLogMessage(message) {
  const timestamp = new Date().toISOString();
  const log = `[${timestamp}] ${message}`;
  console.log(log); // Optional: Also output to console
  fallbackLogStream.write(log + '\n');
}

/**
 * Winston Logger with Log Rotation
 */
const winstonFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(
    (info) => `[${info.timestamp}] [${info.level.toUpperCase()}]: ${info.message}`
  )
);

// Initialize Winston Logger
const winstonLogger = createLogger({
  level: 'info',
  format: winstonFormat,
  transports: [
    // Daily Rotate File Transport
    new transports.DailyRotateFile({
      filename: path.join(__dirname, 'logs', 'trading-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true, // Compress archived logs
      maxSize: '20m',       // Max size per log file
      maxFiles: '14d',      // Retain logs for 14 days
      handleExceptions: true,
    }),
    // Console Transport
    new transports.Console({
      format: format.combine(
        format.colorize(),
        winstonFormat
      ),
      handleExceptions: true,
    }),
  ],
  exitOnError: false, // Do not exit on handled exceptions
});

// Flag to indicate if fallback is active
let isFallbackActive = false;

/**
 * Function to handle Winston transport errors
 * Switches to fallback logger upon failure.
 */
function handleTransportError(error, transportName) {
  if (!isFallbackActive) {
    console.error(`Winston Transport Error [${transportName}]: ${error.message}`);
    console.error('Switching to fallback logger.');

    // Remove all Winston transports to prevent further errors
    winstonLogger.clear();

    isFallbackActive = true;
  }

  // Log the error using fallback logger
  fallbackLogMessage(`Transport [${transportName}] Error: ${error.message}`);
}

/**
 * Attach error listeners to Winston transports
 */
winstonLogger.transports.forEach((transport) => {
  transport.on('error', (error) => {
    handleTransportError(error, transport.name || transport.constructor.name);
  });
});

/**
 * Log Message Function
 * @param {string} message - The log message.
 * @param {string} level - Log level (e.g., 'info', 'warn', 'error', 'debug').
 */
function logMessage(message, level = 'info') {
  if (isFallbackActive) {
    // Use fallback logger
    fallbackLogMessage(`[${level.toUpperCase()}]: ${message}`);
  } else {
    // Use Winston logger
    winstonLogger.log({ level, message });
  }
}

/**
 * Export logger methods to match Winston's interface
 */
// Add this console log to verify the export
//console.log('Logger methods being exported:', Object.keys(module.exports));

// Remove the arrow functions and use regular function declarations
module.exports = {
  error: function (msg) { return logMessage(msg, 'error') },
  info: function (msg) { return logMessage(msg, 'info') },
  warn: function (msg) { return logMessage(msg, 'warn') },
  debug: function (msg) { return logMessage(msg, 'debug') }
};