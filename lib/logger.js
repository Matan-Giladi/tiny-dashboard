'use strict';

// Application logger. pino-http (see server.js) reuses this instance so
// request logs and application logs share one format and one level.
//   LOG_LEVEL=debug|info|warn|error|silent   (default: info)

const pino = require('pino');

module.exports = pino({ level: process.env.LOG_LEVEL || 'info' });
