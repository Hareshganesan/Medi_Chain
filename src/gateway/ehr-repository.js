import { randomUUID, randomBytes } from 'node:crypto';
import { encryptField, decryptField } from '../common/crypto.js';
import { HttpError } from '../common/security.js';

const PATIENT_SECRET_FIELDS = ['phone', 'abhaId'];

export function ageFrom(dob, now = new Date()) {
  const d = new Date(dob);
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/**
 * Data-access layer over the sharded, replicated store.
 * Key layout (all keys of one patient hash to the same shard):
 *   patient:<id>   demographics (phone & ABHA id encrypted)
 *   records:<id>   append-only list of clinical records (content encrypted)
 *   consent:<id>   map doctorId → grant { type, grantedAt, expiresAt?, reason? }
 */
export class EhrRepository {
  constructor({ router, encryptionKey, cache }) {
    this.router = router;
    this.key = encryptionKey;
    this.cache = cache;
  }

  newPatientId() {
    return 'P-' + randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  }

  async write(patientId, command, requestId) {
    const client = this.router.forPatient(patientId);
    const r = await client.command({ ...command, requestId: command.requestId ?? randomUUID() }, requestId);
    this.cache.deletePrefix(`patient:${patientId}`);
    if (r.status === 409) throw new HttpError(409, r.data?.error ?? 'CONFLICT', 'Write conflict');
    if (r.status !== 200) throw new HttpError(r.status, r.data?.error ?? 'WRITE_FAILED', 'Write failed');
    return { ...r.data, shardId: client.shardId, servedBy: r.servedBy };
  }

  async createPatient(input, doctor, requestId) {
    const id = input.id ?? this.newPatientId();
    const patient = {
      id,
      name: input.name,
      dob: input.dob,
      gender: input.gender,
      bloodGroup: input.bloodGroup,
      allergies: input.allergies ?? [],
      createdBy: { id: doctor.sub, name: doctor.name },
      createdAt: new Date().toISOString(),
    };
    for (const f of PATIENT_SECRET_FIELDS) if (input[f]) patient[f] = encryptField(input[f], this.key);
    const w = await this.write(id, { type: 'put', key: `patient:${id}`, value: patient, expectedVersion: 0 }, requestId);
    await this.write(id, {
      type: 'mapSet',
      key: `consent:${id}`,
      field: doctor.sub,
      value: { type: 'treating', doctorName: doctor.name, grantedAt: new Date().toISOString(), grantedBy: doctor.sub },
    });
    return { id, shardId: w.shardId };
  }

  /** Cache-aside read of everything about one patient (linearizable on a miss). */
  async getPatientView(patientId, requestId) {
    const cacheKey = `patient:${patientId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { ...cached, cache: 'HIT' };

    const client = this.router.forPatient(patientId);
    const t0 = performance.now();
    const [p, r, c] = await Promise.all([
      client.get(`patient:${patientId}`, 'strong', requestId),
      client.get(`records:${patientId}`, 'strong', requestId),
      client.get(`consent:${patientId}`, 'strong', requestId),
    ]);
    if (!p.data?.entry) return null;
    const view = {
      patient: { ...p.data.entry.value, version: p.data.entry.version },
      records: r.data?.entry?.value ?? [],
      consents: c.data?.entry?.value ?? {},
      shardId: client.shardId,
      servedBy: p.servedBy,
      storageMs: Math.round(performance.now() - t0),
    };
    this.cache.set(cacheKey, view);
    return { ...view, cache: 'MISS' };
  }

  /** Decrypt for an authorised viewer; ABHA id is masked unless the viewer is the owner. */
  present(view, { owner = false } = {}) {
    const patient = { ...view.patient };
    for (const f of PATIENT_SECRET_FIELDS) if (patient[f]) patient[f] = decryptField(patient[f], this.key);
    if (patient.abhaId && !owner) patient.abhaId = '••••••••••' + patient.abhaId.slice(-4);
    patient.age = ageFrom(patient.dob);
    const records = view.records
      .map((rec) => ({ ...rec, content: rec.content ? decryptField(rec.content, this.key) : rec.content }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { patient, records };
  }

  async addRecord(patientId, record, author, idempotencyKey, requestId) {
    const entry = {
      id: 'R-' + randomUUID().slice(0, 8),
      ...record,
      content: record.content ? encryptField(record.content, this.key) : undefined,
      author: { id: author.sub, name: author.name },
      createdAt: new Date().toISOString(),
    };
    const w = await this.write(
      patientId,
      { type: 'append', key: `records:${patientId}`, value: entry, requestId: idempotencyKey ? `rec:${patientId}:${idempotencyKey}` : undefined },
      requestId,
    );
    const duplicate = Boolean(w.result?.duplicate);
    // On a retried request the store returns the ORIGINAL result, so report the original record id.
    return { record: duplicate ? { id: w.result.itemId } : { ...entry, content: record.content }, duplicate, ...w };
  }

  setConsent(patientId, doctorId, grant, requestId) {
    const cmd = grant
      ? { type: 'mapSet', key: `consent:${patientId}`, field: doctorId, value: grant }
      : { type: 'mapDelete', key: `consent:${patientId}`, field: doctorId };
    return this.write(patientId, cmd, requestId);
  }

  /** Scatter-gather across every shard; returns partial results if a shard is down. */
  async directory(requestId) {
    const t0 = performance.now();
    const degraded = [];
    const perShard = await Promise.all(
      this.router.all().map(async (client) => {
        try {
          // Demographics may come from any replica (eventual); consent drives access decisions, so read it from the leader.
          const [p, c] = await Promise.all([client.scan('patient:', 'eventual', requestId), client.scan('consent:', 'strong', requestId)]);
          const consents = Object.fromEntries(c.data.entries.map((e) => [e.key.slice('consent:'.length), e.value]));
          return p.data.entries.map((e) => ({ ...e.value, consents: consents[e.value.id] ?? {}, shardId: client.shardId, servedBy: p.servedBy }));
        } catch {
          degraded.push(client.shardId);
          return [];
        }
      }),
    );
    return { patients: perShard.flat(), degraded, tookMs: Math.round(performance.now() - t0) };
  }
}
