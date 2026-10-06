import { describe, it, expect } from 'vitest';
import { authorize, activeGrant, ACTIONS as A } from '../../src/common/rbac.js';

/**
 * Decision-table testing of the access-control policy.
 * Conditions: role × action × (ownership | consent type | consent expiry | break-glass reason).
 */
const NOW = Date.parse('2026-10-01T12:00:00Z');
const admin = { sub: 'U-ADMIN', role: 'admin' };
const doctor = { sub: 'D-1', role: 'doctor' };
const patient = { sub: 'U-P1', role: 'patient', patientId: 'P1' };
const future = '2026-10-01T12:30:00Z';
const past = '2026-10-01T11:59:59Z';

const TABLE = [
  // id,            user,    action,              context,                                                     allow, reason
  ['DT-01', admin, A.CLUSTER_MANAGE, {}, true, 'ADMIN_OPERATIONS'],
  ['DT-02', admin, A.AUDIT_READ_ALL, {}, true, 'ADMIN_OPERATIONS'],
  ['DT-03', admin, A.PATIENT_READ, { patientId: 'P1', consents: { 'U-ADMIN': { type: 'consent' } } }, false, 'ADMIN_NO_PHI_ACCESS'],
  ['DT-04', doctor, A.PATIENT_CREATE, {}, true, 'DOCTOR_ROLE'],
  ['DT-05', doctor, A.PATIENT_SEARCH, {}, true, 'DOCTOR_ROLE'],
  ['DT-06', doctor, A.PATIENT_READ, { consents: {} }, false, 'NO_ACTIVE_CONSENT'],
  ['DT-07', doctor, A.PATIENT_READ, { consents: { 'D-1': { type: 'treating' } } }, true, 'TREATING_PHYSICIAN'],
  ['DT-08', doctor, A.PATIENT_READ, { consents: { 'D-1': { type: 'consent' } } }, true, 'PATIENT_CONSENT'],
  ['DT-09', doctor, A.PATIENT_READ, { consents: { 'D-1': { type: 'breakglass', expiresAt: future } } }, true, 'BREAK_GLASS_ACTIVE'],
  ['DT-10', doctor, A.PATIENT_READ, { consents: { 'D-1': { type: 'breakglass', expiresAt: past } } }, false, 'NO_ACTIVE_CONSENT'],
  ['DT-11', doctor, A.PATIENT_READ, { consents: { 'D-2': { type: 'consent' } } }, false, 'NO_ACTIVE_CONSENT'],
  ['DT-12', doctor, A.RECORD_CREATE, { consents: { 'D-1': { type: 'consent' } } }, true, 'PATIENT_CONSENT'],
  ['DT-13', doctor, A.RECORD_CREATE, { consents: {} }, false, 'NO_ACTIVE_CONSENT'],
  ['DT-14', doctor, A.BREAK_GLASS, { reason: 'Unconscious in ER' }, true, 'EMERGENCY_OVERRIDE'],
  ['DT-15', doctor, A.BREAK_GLASS, { reason: '123456789' }, false, 'BREAK_GLASS_REASON_REQUIRED'], // BVA: 9 chars
  ['DT-16', doctor, A.BREAK_GLASS, { reason: '1234567890' }, true, 'EMERGENCY_OVERRIDE'], // BVA: 10 chars
  ['DT-17', doctor, A.BREAK_GLASS, { reason: '          x' }, false, 'BREAK_GLASS_REASON_REQUIRED'], // whitespace padding
  ['DT-18', doctor, A.BREAK_GLASS, {}, false, 'BREAK_GLASS_REASON_REQUIRED'],
  ['DT-19', doctor, A.CLUSTER_MANAGE, {}, false, 'ACTION_NOT_PERMITTED_FOR_ROLE'],
  ['DT-20', patient, A.PATIENT_READ, { patientId: 'P1' }, true, 'DATA_OWNER'],
  ['DT-21', patient, A.PATIENT_READ, { patientId: 'P2' }, false, 'NOT_OWNER'], // IDOR
  ['DT-22', patient, A.CONSENT_MANAGE, { patientId: 'P1' }, true, 'DATA_OWNER'],
  ['DT-23', patient, A.ACCESS_LOG_READ, { patientId: 'P2' }, false, 'NOT_OWNER'],
  ['DT-24', patient, A.RECORD_CREATE, { patientId: 'P1' }, false, 'ACTION_NOT_PERMITTED_FOR_ROLE'],
  ['DT-25', patient, A.CLUSTER_MANAGE, {}, false, 'ACTION_NOT_PERMITTED_FOR_ROLE'],
  ['DT-26', null, A.PATIENT_READ, {}, false, 'UNAUTHENTICATED'],
  ['DT-27', { sub: 'x', role: 'hacker' }, A.PATIENT_READ, {}, false, 'UNKNOWN_ROLE'],
  ['DT-28', patient, A.PATIENT_READ, {}, false, 'NOT_OWNER'], // missing patientId must not match undefined
];

describe('RBAC/ABAC policy — decision table', () => {
  it.each(TABLE)('TC-RBAC %s: %o %s → allow=%s', (id, user, action, ctx, allow, reason) => {
    expect(authorize(user, action, { now: NOW, ...ctx })).toEqual({ allow, reason });
  });

  it('TC-RBAC-29 (BVA): a grant expiring exactly now is no longer active', () => {
    expect(activeGrant({ d: { expiresAt: new Date(NOW).toISOString() } }, 'd', NOW)).toBeNull();
    expect(activeGrant({ d: { expiresAt: new Date(NOW + 1).toISOString() } }, 'd', NOW)).not.toBeNull();
    expect(activeGrant(undefined, 'd', NOW)).toBeNull();
  });
});
