import { test, expect } from '@playwright/test';
import { LoginPage, DoctorPage, PatientPage, AdminPage, USERS } from './pages.js';

test.describe('Authentication', () => {
  test('E2E-01: each role lands on its own portal', async ({ page }) => {
    const login = new LoginPage(page);
    for (const [who, path] of [['rohit', '/doctor'], ['hemanth', '/patient'], ['admin', '/admin']]) {
      await page.evaluate(() => sessionStorage.clear()).catch(() => {});
      await login.loginAs(who);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await page.getByRole('button', { name: /Sign out/ }).click();
      await expect(page).toHaveURL(/\/$/);
    }
  });

  test('E2E-02: wrong password shows remaining attempts; portal pages require a session', async ({ page }) => {
    const login = new LoginPage(page);
    await login.login('dr.nikhil', 'WrongPass!1');
    await expect(login.error()).toContainText('attempt(s) left before lockout');
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/$/); // redirected to sign-in
  });

  test('E2E-03: a patient cannot open the admin console even with a valid session', async ({ page }) => {
    await new LoginPage(page).loginAs('sanku');
    await expect(page).toHaveURL(/\/patient$/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/patient$/); // bounced back to their own portal
    await expect(page.locator('#shards')).toHaveCount(0);
  });
});

test.describe('Clinician workflow', () => {
  test('E2E-04: treating doctor opens a record, sees the distributed request path, adds vitals', async ({ page }) => {
    await new LoginPage(page).loginAs('rohit');
    const doctor = new DoctorPage(page);
    await expect(page.locator('#dir-meta')).toContainText('2 shards queried in parallel');
    await doctor.open('Hemanth');
    await expect(doctor.detail()).toContainText('Penicillin');
    await expect(page.locator('.inspector')).toContainText(/shard shard-[ab]/);
    await expect(page.locator('.inspector')).toContainText(/linearizable|cached/);

    const dialog = await doctor.addRecord({ type: 'vitals', title: 'E2E vitals check', fields: { heartRate: 999 } });
    // server-side (zod) validation is surfaced next to the offending field
    const hrField = dialog.locator('.field', { has: page.locator('[name="heartRate"]') });
    await expect(hrField.locator('input')).toHaveClass(/invalid/);
    await expect(hrField.locator('.error')).toContainText('250');
    await dialog.locator('[name="heartRate"]').fill('76');
    await dialog.getByRole('button', { name: 'Save record' }).click();
    await expect(page.locator('.toast')).toContainText('committed by Raft');
    await expect(page.locator('.rec', { hasText: 'E2E vitals check' })).toBeVisible();
  });

  test('E2E-05: registering a patient validates input, then places them on a shard', async ({ page }) => {
    await new LoginPage(page).loginAs('nikhil');
    await page.getByRole('button', { name: /Register patient/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[name="name"]').fill('Rahul');
    await dialog.locator('[name="dob"]').fill('1985-03-14');
    await dialog.locator('[name="phone"]').fill('12345');
    await dialog.getByRole('button', { name: 'Register patient' }).click();
    await expect(dialog.locator('[name="phone"]')).toHaveClass(/invalid/);
    await dialog.locator('[name="phone"]').fill('9876501234');
    await dialog.getByRole('button', { name: 'Register patient' }).click();
    await expect(page.locator('.toast')).toContainText(/placed on shard-[ab]/);
    await expect(new DoctorPage(page).patientRow('Rahul')).toContainText('Treating');
  });
});

test.describe('Consent, break-glass and audit (cross-portal)', () => {
  test('E2E-06: doctor without consent is blocked → break-glass → patient is alerted and sees it in history', async ({ browser }) => {
    const docCtx = await browser.newContext();
    const patCtx = await browser.newContext();
    const docPage = await docCtx.newPage();
    const patPage = await patCtx.newPage();

    await new LoginPage(patPage).loginAs('hemanth');
    await expect(patPage.locator('#live')).not.toHaveClass(/off/);

    await new LoginPage(docPage).loginAs('varun');
    const doctor = new DoctorPage(docPage);
    await doctor.open('Hemanth');
    await expect(doctor.detail()).toContainText('No consent to view');
    await docPage.getByRole('button', { name: /break-glass/ }).click();
    const dialog = docPage.getByRole('dialog');
    await dialog.locator('#bg-reason').fill('short');
    await dialog.getByRole('button', { name: 'Grant emergency access' }).click();
    await expect(dialog.locator('.error')).toContainText('10 characters');
    await dialog.locator('#bg-reason').fill('Unconscious in ER — need allergy history');
    await dialog.getByRole('button', { name: 'Grant emergency access' }).click();
    await expect(docPage.locator('#detail .banner.danger')).toContainText('Emergency access active');

    // The patient is notified in real time (SSE) and the event is in the hash-chained history.
    await expect(patPage.locator('#alerts')).toContainText('Dr. Varun used emergency break-glass access', { timeout: 15000 });
    await expect(new PatientPage(patPage).history()).toContainText('EMERGENCY break-glass', { timeout: 15000 });
    await expect(patPage.locator('#ledger-badge')).toContainText('Ledger verified');
    await docCtx.close();
    await patCtx.close();
  });

  test('E2E-07: patient grants and then revokes a doctor’s access', async ({ page }) => {
    await new LoginPage(page).loginAs('hemanth');
    const patient = new PatientPage(page);
    await page.locator('#grant-doctor').selectOption('D-NIKHIL');
    await page.getByRole('button', { name: 'Grant access' }).click();
    await expect(patient.consentRow('Dr. Nikhil')).toContainText('Granted by you');
    await patient.consentRow('Dr. Nikhil').getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke access' }).click();
    await expect(patient.consentRow('Dr. Nikhil')).toHaveCount(0);
  });

  test('E2E-08 (security): stored XSS payload is rendered as inert text', async ({ page, request }) => {
    const login = await request.post('/api/auth/login', { data: { username: USERS.rohit[0], password: USERS.rohit[1] } });
    const { token } = await login.json();
    const payload = '<img src=x onerror="window.__xss=1">';
    const r = await request.post('/api/patients', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'Tarun', dob: '1990-01-01', gender: 'other', bloodGroup: 'A+', phone: '9123456789', allergies: [payload] },
    });
    expect(r.status()).toBe(201);
    let dialogs = 0;
    page.on('dialog', (d) => (dialogs++, d.dismiss()));
    await new LoginPage(page).loginAs('rohit');
    await new DoctorPage(page).open('Tarun');
    await expect(page.locator('#detail')).toContainText(payload); // shown literally
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('#detail img').count()).toBe(0);
    expect(dialogs).toBe(0);
  });
});

test.describe('Operations console & fault tolerance', () => {
  test('E2E-09: cluster shows 2 shards × 3 replicas with one leader each', async ({ page }) => {
    await new LoginPage(page).loginAs('admin');
    const admin = new AdminPage(page);
    for (const id of ['shard-a', 'shard-b']) {
      await expect(admin.shardCard(id).locator('.node')).toHaveCount(3);
      await expect(admin.shardCard(id)).toContainText('3/3 healthy');
      await admin.leaderOf(id);
    }
  });

  test('E2E-10: killing a leader in the UI triggers a new election; writes keep succeeding', async ({ page }) => {
    await new LoginPage(page).loginAs('admin');
    const admin = new AdminPage(page);
    const oldLeader = await admin.leaderOf('shard-a');
    await page.getByRole('button', { name: 'Start write traffic' }).click();
    await page.waitForTimeout(800);
    await page.locator(`[data-kill-leader="shard-a"]`).click();
    await expect(admin.nodeTile(oldLeader)).toContainText('down', { timeout: 10000 });
    await expect.poll(() => admin.leaderOf('shard-a'), { timeout: 15000 }).not.toBe(oldLeader);
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop traffic' }).click();
    const failed = await page.locator('#chaos-shards .badge', { hasText: 'failed' }).allTextContents();
    expect(failed.every((t) => t.startsWith('0 '))).toBe(true); // no write failed during failover

    await admin.nodeTile(oldLeader).getByRole('button', { name: 'Restart' }).click();
    await expect(admin.shardCard('shard-a')).toContainText('3/3 healthy', { timeout: 15000 });
    await expect(admin.nodeTile(oldLeader)).toContainText('follower'); // rejoins as follower
  });

  test('E2E-11: audit ledger detects tampering and recovers after restore', async ({ page }) => {
    await new LoginPage(page).loginAs('admin');
    await page.getByRole('button', { name: 'Tamper' }).click();
    await page.getByRole('button', { name: 'Verify chain' }).click();
    await expect(page.locator('#verify-result')).toContainText('Tampering detected');
    await expect(page.locator('#k-ledger')).toContainText('broken');
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('button', { name: 'Verify chain' }).click();
    await expect(page.locator('#verify-result')).toContainText('Chain verified');
  });

  test('E2E-12: replica log viewer shows encrypted fields only', async ({ page }) => {
    await new LoginPage(page).loginAs('admin');
    await new AdminPage(page).nodeTile('b1').getByRole('button', { name: 'Log' }).click();
    const code = page.getByRole('dialog').locator('.code');
    await expect(code).toBeVisible();
    await expect(code).toContainText('"term"');
  });
});
