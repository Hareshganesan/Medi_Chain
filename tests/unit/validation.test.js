import { describe, it, expect } from 'vitest';
import { patientSchema, recordSchema, passwordSchema, usernameSchema, breakGlassSchema, validate } from '../../src/common/validation.js';

/**
 * Black-box input validation using Equivalence Partitioning (EP)
 * and Boundary Value Analysis (BVA).
 */
const base = { name: 'Ashwin', dob: '1990-01-01', gender: 'female', bloodGroup: 'O+', phone: '9876543210' };
const ok = (schema, v) => schema.safeParse(v).success;
const isoDaysFromToday = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const yearsAgo = (y, extraDays = 0) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - y);
  d.setDate(d.getDate() + extraDays);
  return d.toISOString().slice(0, 10);
};

describe('Patient registration — name (BVA on length 2..80)', () => {
  it.each([
    ['1 char (min-1)', 'A', false],
    ['2 chars (min)', 'Sa', true],
    ['80 chars (max)', 'A'.repeat(80), true],
    ['81 chars (max+1)', 'A'.repeat(81), false],
    ['unicode letters (Tamil)', 'ஹேமந்த்', true],
    ["apostrophe & hyphen", "O'Allan-Sanku", true],
    ['digits (invalid class)', 'R2D2', false],
    ['script injection', '<script>alert(1)</script>', false],
    ['whitespace trimmed to 1 char', '  A  ', false],
  ])('TC-VAL-NAME %s', (_, name, expected) => expect(ok(patientSchema, { ...base, name })).toBe(expected));
});

describe('Patient registration — date of birth (BVA on 0..130 years)', () => {
  it.each([
    ['today (age 0)', isoDaysFromToday(0), true],
    ['tomorrow (future)', isoDaysFromToday(1), false],
    ['exactly 130 years', yearsAgo(130, 1), true],
    ['130 years + 1 day', yearsAgo(130, -1), false],
    ['impossible date 2023-02-30', '2023-02-30', false],
    ['wrong format 01/01/1990', '01/01/1990', false],
  ])('TC-VAL-DOB %s', (_, dob, expected) => expect(ok(patientSchema, { ...base, dob })).toBe(expected));
});

describe('Patient registration — phone & ABHA (EP)', () => {
  it.each([
    ['valid mobile starting 9', { phone: '9876543210' }, true],
    ['valid mobile starting 6', { phone: '6000000000' }, true],
    ['starts with 5 (invalid partition)', { phone: '5876543210' }, false],
    ['9 digits', { phone: '987654321' }, false],
    ['11 digits', { phone: '98765432101' }, false],
    ['ABHA 14 digits', { abhaId: '12345678901234' }, true],
    ['ABHA 13 digits', { abhaId: '1234567890123' }, false],
    ['ABHA 15 digits', { abhaId: '123456789012345' }, false],
    ['ABHA with letters', { abhaId: '1234567890123X' }, false],
    ['unknown blood group', { bloodGroup: 'C+' }, false],
    ['unknown gender', { gender: 'robot' }, false],
    ['21 allergies (max+1)', { allergies: Array(21).fill('x') }, false],
  ])('TC-VAL-PII %s', (_, patch, expected) => expect(ok(patientSchema, { ...base, ...patch })).toBe(expected));
});

describe('Password & username policy', () => {
  it.each([
    ['7 chars (min-1)', 'Ab1!xyz', false],
    ['8 chars (min)', 'Ab1!xyzw', true],
    ['64 chars (max)', 'Ab1!' + 'x'.repeat(60), true],
    ['65 chars (max+1)', 'Ab1!' + 'x'.repeat(61), false],
    ['no uppercase', 'ab1!xyzw', false],
    ['no lowercase', 'AB1!XYZW', false],
    ['no digit', 'Abc!xyzw', false],
    ['no special', 'Abc1xyzw', false],
  ])('TC-VAL-PWD %s', (_, pwd, expected) => expect(ok(passwordSchema, pwd)).toBe(expected));

  it.each([
    ['ab', false],
    ['abc', true],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['Hemanth', false],
    ['hemanth.k_1', true],
    ['hemanth kumar', false],
  ])('TC-VAL-USER "%s" → %s', (u, expected) => expect(ok(usernameSchema, u)).toBe(expected));
});

describe('Clinical records (EP per record type + BVA on vitals)', () => {
  const vitals = { type: 'vitals', title: 'Vitals', heartRate: 80, systolic: 120, diastolic: 80, temperature: 37, spo2: 98 };
  it.each([
    ['heart rate 19 (min-1)', { heartRate: 19 }, false],
    ['heart rate 20 (min)', { heartRate: 20 }, true],
    ['heart rate 250 (max)', { heartRate: 250 }, true],
    ['heart rate 251 (max+1)', { heartRate: 251 }, false],
    ['SpO2 100 (max)', { spo2: 100 }, true],
    ['SpO2 101 (max+1)', { spo2: 101 }, false],
    ['temperature 45.0 (max)', { temperature: 45 }, true],
    ['temperature 45.1 (max+1)', { temperature: 45.1 }, false],
    ['diastolic == systolic', { systolic: 100, diastolic: 100 }, false],
    ['diastolic < systolic by 1', { systolic: 100, diastolic: 99 }, true],
    ['heart rate not an integer', { heartRate: 80.5 }, false],
    ['heart rate as string', { heartRate: '80' }, false],
  ])('TC-VAL-VITALS %s', (_, patch, expected) => expect(ok(recordSchema, { ...vitals, ...patch })).toBe(expected));

  it.each([
    ['valid note', { type: 'note', title: 'Consult', content: 'Stable.' }, true],
    ['title 2 chars (min-1)', { type: 'note', title: 'ab', content: 'x' }, false],
    ['title 3 chars (min)', { type: 'note', title: 'abc', content: 'x' }, true],
    ['note 5000 chars (max)', { type: 'note', title: 'Long', content: 'x'.repeat(5000) }, true],
    ['note 5001 chars (max+1)', { type: 'note', title: 'Long', content: 'x'.repeat(5001) }, false],
    ['empty note', { type: 'note', title: 'Empty', content: '   ' }, false],
    ['unknown type', { type: 'xray', title: 'Chest' }, false],
    ['lab with 0 results', { type: 'lab', title: 'CBC', results: [] }, false],
    ['lab with 1 result', { type: 'lab', title: 'CBC', results: [{ test: 'Hb', value: 12 }] }, true],
    ['lab value Infinity', { type: 'lab', title: 'CBC', results: [{ test: 'Hb', value: Infinity }] }, false],
    ['prescription 365 days (max)', { type: 'prescription', title: 'Rx plan', medication: 'Metformin', dosage: '500mg', frequency: 'BD', durationDays: 365 }, true],
    ['prescription 366 days (max+1)', { type: 'prescription', title: 'Rx plan', medication: 'Metformin', dosage: '500mg', frequency: 'BD', durationDays: 366 }, false],
    ['prescription 0 days (min-1)', { type: 'prescription', title: 'Rx plan', medication: 'Metformin', dosage: '500mg', frequency: 'BD', durationDays: 0 }, false],
  ])('TC-VAL-REC %s', (_, rec, expected) => expect(ok(recordSchema, rec)).toBe(expected));
});

describe('validate() helper', () => {
  it('TC-VAL-01: throws a 400 VALIDATION_ERROR with field paths', () => {
    try {
      validate(breakGlassSchema, { reason: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(err.details[0].path).toBe('reason');
    }
  });

  it('TC-VAL-02: returns parsed data with defaults applied', () => {
    expect(validate(patientSchema, base).allergies).toEqual([]);
  });
});
