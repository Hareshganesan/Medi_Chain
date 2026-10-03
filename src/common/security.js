import { generateKeyPairSync, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

export function generateKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * RS256: only the auth service holds the private key; every other service
 * verifies tokens locally with the public key — no call back to auth per request.
 */
export function signToken(payload, privateKey, expiresIn = '2h') {
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn, issuer: 'medichain-auth', jwtid: randomUUID() });
}

export function verifyToken(token, publicKey) {
  return jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'medichain-auth' });
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Zero-trust: internal endpoints demand the service token even on the private network. */
export function requireServiceToken(token) {
  return (req, res, next) => {
    if (safeEqual(req.get('x-service-token'), token)) return next();
    res.status(401).json({ error: 'SERVICE_TOKEN_REQUIRED' });
  };
}

/** Propagate a correlation id through every hop for distributed tracing. */
export function requestId(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

export function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Final Express error handler shared by all services. */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) logger?.error(err.message, { requestId: req.id, stack: err.stack?.split('\n')[1]?.trim() });
    res.status(status).json({
      error: err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
      message: status >= 500 && !err.expose ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
      requestId: req.id,
    });
  };
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.expose = true;
    Object.assign(this, extra);
  }
}

/** Start an Express app and resolve once it is listening (port 0 = random, for tests). */
export function listen(app, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

export const serverUrl = (server) => `http://127.0.0.1:${server.address().port}`;

/** Close a server and any keep-alive / streaming sockets it still holds. */
export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
