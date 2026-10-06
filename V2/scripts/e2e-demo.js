/**
 * Runs the Playwright browser tests in a visible browser window, slowed down so an
 * audience can follow each click (`npm run test:e2e:demo`). Works the same on Windows,
 * macOS and Linux, where setting PW_SLOWMO inline in an npm script would not.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { headedChannel } from './browser-channel.js';

const cli = path.resolve('node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cli, 'test', '--headed', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PW_SLOWMO: process.env.PW_SLOWMO || '300', PW_CHANNEL: headedChannel() },
});
child.on('exit', (code) => process.exit(code ?? 1));
