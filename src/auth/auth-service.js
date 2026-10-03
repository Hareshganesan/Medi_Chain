import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { createLogger } from '../common/logger.js';
import { generateKeyPair, signToken, requireServiceToken, requestId, errorHandler, listen, closeServer, HttpError } from '../common/security.js';
import { validate, loginSchema, usernameSchema, passwordSchema } from '../common/validation.js';
import { z } from 'zod';

export const DEMO_USERS = [
  { id: 'U-ADMIN', username: 'admin', password: 'Admin@123', name: 'Sidharth', role: 'admin', title: 'Platform Operations' },
  { id: 'D-ROHIT', username: 'dr.rohit', password: 'Doctor@123', name: 'Dr. Rohit', role: 'doctor', title: 'Cardiology · Apollo Chennai' },
  { id: 'D-VARUN', username: 'dr.varun', password: 'Doctor@123', name: 'Dr. Varun', role: 'doctor', title: 'Emergency Medicine · MIOT' },
  { id: 'D-NIKHIL', username: 'dr.nikhil', password: 'Doctor@123', name: 'Dr. Nikhil', role: 'doctor', title: 'General Medicine · Kauvery' },
];

const publicUser = ({ passwordHash, failedAttempts, lockedUntil, ...u }) => u;

/**
 * Identity provider: verifies credentials, enforces account lockout, and issues
 * RS256-signed JWTs. Other services only ever need its PUBLIC key.
 */
export async function startAuthService({
  port = 0,
  dataDir = null,
  token,
  maxFailedAttempts = 5,
  lockoutMs = 5 * 60 * 1000,
  tokenTtl = '8h',
  bcryptRounds = Number(process.env.BCRYPT_ROUNDS || 10),
  now = Date.now,
  logger = createLogger('auth'),
} = {}) {
  const dir = dataDir ? path.join(dataDir, 'auth') : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const usersFile = dir && path.join(dir, 'users.json');
  const keysFile = dir && path.join(dir, 'keys.json');

  // Keys persist so tokens stay valid across an auth-service restart.
  let keys;
  if (keysFile && fs.existsSync(keysFile)) keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  else {
    keys = generateKeyPair();
    if (keysFile) fs.writeFileSync(keysFile, JSON.stringify(keys));
  }

  const dummyHash = bcrypt.hashSync('timing-equaliser', bcryptRounds);
  const users = new Map();
  const save = () => usersFile && fs.writeFileSync(usersFile, JSON.stringify([...users.values()], null, 2));
  if (usersFile && fs.existsSync(usersFile)) {
    for (const u of JSON.parse(fs.readFileSync(usersFile, 'utf8'))) users.set(u.username, u);
  } else {
    for (const { password, ...u } of DEMO_USERS) {
      users.set(u.username, { ...u, passwordHash: bcrypt.hashSync(password, bcryptRounds), failedAttempts: 0, lockedUntil: 0 });
    }
    save();
  }

  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.get('/health', (req, res) => res.json({ ok: true, users: users.size }));
  app.get('/public-key', (req, res) => res.json({ publicKey: keys.publicKey, alg: 'RS256' }));

  app.post('/login', async (req, res) => {
    const { username, password } = validate(loginSchema, req.body);
    const user = users.get(username.toLowerCase().trim());
    // Same response for unknown user and wrong password → no username enumeration.
    if (!user) {
      await bcrypt.compare(password, dummyHash); // equalise timing
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    }
    if (user.lockedUntil > now()) {
      throw new HttpError(423, 'ACCOUNT_LOCKED', 'Account locked after repeated failures', {
        details: [{ retryAfterSec: Math.ceil((user.lockedUntil - now()) / 1000) }],
      });
    }
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      user.failedAttempts += 1;
      const left = maxFailedAttempts - user.failedAttempts;
      if (left <= 0) {
        user.lockedUntil = now() + lockoutMs;
        user.failedAttempts = 0;
        save();
        logger.warn(`account locked: ${user.username}`);
        throw new HttpError(423, 'ACCOUNT_LOCKED', 'Account locked after repeated failures', {
          details: [{ retryAfterSec: Math.ceil(lockoutMs / 1000) }],
        });
      }
      save();
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password', { details: [{ attemptsLeft: left }] });
    }
    user.failedAttempts = 0;
    user.lockedUntil = 0;
    save();
    const claims = { sub: user.id, name: user.name, role: user.role, username: user.username };
    if (user.patientId) claims.patientId = user.patientId;
    res.json({ token: signToken(claims, keys.privateKey, tokenTtl), user: publicUser(user) });
  });

  // ─── internal API (service token required) ───
  const internal = express.Router();
  internal.use(requireServiceToken(token));

  internal.get('/users', (req, res) => {
    const list = [...users.values()].filter((u) => !req.query.role || u.role === req.query.role).map(publicUser);
    res.json({ users: list });
  });

  const newPatientAccount = z.object({
    username: usernameSchema,
    password: passwordSchema,
    name: z.string().min(2).max(80),
    patientId: z.string().min(1),
  });

  internal.post('/users', async (req, res) => {
    const body = validate(newPatientAccount, req.body);
    if (users.has(body.username)) throw new HttpError(409, 'USERNAME_TAKEN', 'Username already exists');
    const user = {
      id: `U-${body.patientId}`,
      username: body.username,
      name: body.name,
      role: 'patient',
      patientId: body.patientId,
      title: `Patient · ${body.patientId}`,
      passwordHash: await bcrypt.hash(body.password, bcryptRounds),
      failedAttempts: 0,
      lockedUntil: 0,
    };
    users.set(user.username, user);
    save();
    res.status(201).json({ user: publicUser(user) });
  });

  app.use('/internal', internal);
  app.use(errorHandler(logger));

  const server = await listen(app, port);
  logger.info(`auth service listening on :${server.address().port}`);
  return { server, url: `http://127.0.0.1:${server.address().port}`, publicKey: keys.publicKey, close: () => closeServer(server) };
}
