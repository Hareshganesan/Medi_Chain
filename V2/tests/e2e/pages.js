import { expect } from '@playwright/test';

/** Page Object Model — tests talk to pages through intent-revealing methods, not selectors. */
export const USERS = {
  admin: ['admin', 'Admin@123'],
  rohit: ['dr.rohit', 'Doctor@123'],
  varun: ['dr.varun', 'Doctor@123'],
  nikhil: ['dr.nikhil', 'Doctor@123'],
  hemanth: ['hemanth', 'Patient@123'],
  sanku: ['sanku', 'Patient@123'],
};

export class LoginPage {
  constructor(page) {
    this.page = page;
  }
  async goto() {
    await this.page.goto('/');
  }
  async login(username, password) {
    await this.goto();
    await this.page.getByLabel('Username').fill(username);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  async loginAs(who) {
    await this.login(...USERS[who]);
  }
  error() {
    return this.page.getByRole('alert');
  }
}

export class DoctorPage {
  constructor(page) {
    this.page = page;
  }
  patientRow(name) {
    return this.page.locator('.pitem', { hasText: name });
  }
  async open(name) {
    await this.patientRow(name).click();
  }
  detail() {
    return this.page.locator('#detail');
  }
  async addRecord({ type, title, fields = {} }) {
    await this.page.getByRole('button', { name: 'Add record' }).click();
    const dialog = this.page.getByRole('dialog');
    await dialog.locator('#rec-type').selectOption(type);
    await dialog.locator('[name="title"]').fill(title);
    for (const [name, value] of Object.entries(fields)) await dialog.locator(`[name="${name}"]`).fill(String(value));
    await dialog.getByRole('button', { name: 'Save record' }).click();
    return dialog;
  }
}

export class PatientPage {
  constructor(page) {
    this.page = page;
  }
  consentRow(doctor) {
    return this.page.locator('#consent-list tr', { hasText: doctor });
  }
  history() {
    return this.page.locator('#history-list');
  }
}

export class AdminPage {
  constructor(page) {
    this.page = page;
  }
  shardCard(id) {
    return this.page.locator('.shard-card', { hasText: id });
  }
  async leaderOf(id) {
    const badge = this.shardCard(id).locator('.card-head .badge', { hasText: 'leader' });
    await expect(badge).toBeVisible();
    return (await badge.textContent()).match(/leader (\w+)/)[1];
  }
  nodeTile(nodeId) {
    return this.page.locator('.node', { has: this.page.locator('.nid', { hasText: new RegExp(`^${nodeId}$`) }) });
  }
}
