/**
 * Access-control policy: RBAC (what a role may do) + ABAC (attributes of the
 * specific request — patient consent, ownership, emergency break-glass, expiry).
 *
 * Pure function, no I/O → every rule is covered by the decision-table tests.
 * Returns { allow, reason } so every decision can be written to the audit trail.
 */
export const ROLES = Object.freeze({ ADMIN: 'admin', DOCTOR: 'doctor', PATIENT: 'patient' });

export const ACTIONS = Object.freeze({
  PATIENT_CREATE: 'patient:create',
  PATIENT_SEARCH: 'patient:search',
  PATIENT_READ: 'patient:read',
  RECORD_CREATE: 'record:create',
  BREAK_GLASS: 'patient:break-glass',
  CONSENT_MANAGE: 'consent:manage',
  ACCESS_LOG_READ: 'access-log:read',
  CLUSTER_MANAGE: 'cluster:manage',
  AUDIT_READ_ALL: 'audit:read-all',
});

/** Is there a currently valid grant for this doctor in the patient's consent map? */
export function activeGrant(consents, doctorId, now = Date.now()) {
  const g = consents?.[doctorId];
  if (!g) return null;
  if (g.expiresAt && new Date(g.expiresAt).getTime() <= now) return null;
  return g;
}

const allow = (reason) => ({ allow: true, reason });
const deny = (reason) => ({ allow: false, reason });

export function authorize(user, action, ctx = {}) {
  if (!user || !user.role) return deny('UNAUTHENTICATED');
  const now = ctx.now ?? Date.now();

  switch (user.role) {
    case ROLES.ADMIN:
      // Least privilege: operators run the platform but never see clinical data.
      if (action === ACTIONS.CLUSTER_MANAGE || action === ACTIONS.AUDIT_READ_ALL) return allow('ADMIN_OPERATIONS');
      return deny('ADMIN_NO_PHI_ACCESS');

    case ROLES.DOCTOR: {
      if (action === ACTIONS.PATIENT_CREATE || action === ACTIONS.PATIENT_SEARCH) return allow('DOCTOR_ROLE');
      if (action === ACTIONS.BREAK_GLASS) {
        if (!ctx.reason || ctx.reason.trim().length < 10) return deny('BREAK_GLASS_REASON_REQUIRED');
        return allow('EMERGENCY_OVERRIDE');
      }
      if (action === ACTIONS.PATIENT_READ || action === ACTIONS.RECORD_CREATE) {
        const g = activeGrant(ctx.consents, user.sub, now);
        if (!g) return deny('NO_ACTIVE_CONSENT');
        if (g.type === 'breakglass') return allow('BREAK_GLASS_ACTIVE');
        return allow(g.type === 'treating' ? 'TREATING_PHYSICIAN' : 'PATIENT_CONSENT');
      }
      return deny('ACTION_NOT_PERMITTED_FOR_ROLE');
    }

    case ROLES.PATIENT: {
      const own = ctx.patientId && ctx.patientId === user.patientId;
      if ([ACTIONS.PATIENT_READ, ACTIONS.CONSENT_MANAGE, ACTIONS.ACCESS_LOG_READ].includes(action)) {
        return own ? allow('DATA_OWNER') : deny('NOT_OWNER');
      }
      return deny('ACTION_NOT_PERMITTED_FOR_ROLE');
    }

    default:
      return deny('UNKNOWN_ROLE');
  }
}
