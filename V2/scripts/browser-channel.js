/**
 * Which browser to show in visible (headed) E2E demos.
 * PW_CHANNEL wins if set. On Windows we prefer the installed Microsoft Edge: it is always
 * present, kept up to date by the OS, and does not depend on Playwright's Chromium download.
 * Headless runs keep using Playwright's bundled headless shell.
 */
import fs from 'node:fs';

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];

export function headedChannel(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (env.PW_CHANNEL) return env.PW_CHANNEL;
  if (platform === 'win32' && EDGE.some((p) => exists(p))) return 'msedge';
  return '';
}
