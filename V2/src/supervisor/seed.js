import { httpJson } from '../common/http.js';

/**
 * Seeds realistic demo data THROUGH THE PUBLIC API (dog-fooding the gateway,
 * auth, RBAC, sharding and replication paths rather than writing files directly).
 */
const PATIENTS = [
  {
    by: 'dr.rohit',
    data: { name: 'Hemanth', dob: '1968-04-12', gender: 'male', bloodGroup: 'B+', phone: '9840012345', abhaId: '91234567890123', allergies: ['Penicillin'], account: { username: 'hemanth', password: 'Patient@123' } },
    records: [
      { type: 'vitals', title: 'OPD vitals', heartRate: 88, systolic: 148, diastolic: 94, temperature: 36.8, spo2: 97, content: 'Patient reports occasional chest tightness on exertion.' },
      { type: 'lab', title: 'Lipid profile', results: [
        { test: 'Total cholesterol', value: 242, unit: 'mg/dL', refRange: '< 200', flag: 'high' },
        { test: 'LDL', value: 162, unit: 'mg/dL', refRange: '< 100', flag: 'high' },
        { test: 'HDL', value: 38, unit: 'mg/dL', refRange: '> 40', flag: 'low' },
        { test: 'Triglycerides', value: 190, unit: 'mg/dL', refRange: '< 150', flag: 'high' } ] },
      { type: 'note', title: 'Cardiology consult', content: 'Stage 1 hypertension with dyslipidaemia. ECG: normal sinus rhythm, no ST changes. Advised TMT. Lifestyle modification discussed — low-salt diet, 30 min brisk walk daily.' },
      { type: 'prescription', title: 'Antihypertensive', medication: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily (morning)', durationDays: 90 },
      { type: 'prescription', title: 'Statin therapy', medication: 'Atorvastatin', dosage: '20 mg', frequency: 'Once daily (night)', durationDays: 90 },
    ],
  },
  {
    by: 'dr.rohit',
    data: { name: 'Sanku', dob: '1991-09-23', gender: 'male', bloodGroup: 'O+', phone: '9789054321', abhaId: '55512345678901', allergies: [], account: { username: 'sanku', password: 'Patient@123' } },
    records: [
      { type: 'vitals', title: 'Routine check-up', heartRate: 72, systolic: 116, diastolic: 76, temperature: 36.6, spo2: 99 },
      { type: 'lab', title: 'Complete blood count', results: [
        { test: 'Haemoglobin', value: 11.2, unit: 'g/dL', refRange: '13.5–17.5', flag: 'low' },
        { test: 'WBC', value: 7.2, unit: '10³/µL', refRange: '4–11', flag: 'normal' },
        { test: 'Platelets', value: 265, unit: '10³/µL', refRange: '150–450', flag: 'normal' } ] },
      { type: 'note', title: 'Mild iron-deficiency anaemia', content: 'Fatigue for 2 months. Hb 11.2. Started on oral iron, review with repeat CBC in 6 weeks.' },
      { type: 'prescription', title: 'Iron supplement', medication: 'Ferrous ascorbate', dosage: '100 mg', frequency: 'Once daily after lunch', durationDays: 60 },
    ],
  },
  {
    by: 'dr.rohit',
    data: { name: 'Mithilesh', dob: '1955-01-30', gender: 'male', bloodGroup: 'A+', phone: '9444098765', allergies: ['Sulfa drugs', 'Iodine contrast'] },
    records: [
      { type: 'vitals', title: 'Post-PCI follow-up', heartRate: 64, systolic: 128, diastolic: 80, temperature: 36.7, spo2: 96 },
      { type: 'note', title: 'Post-angioplasty review', content: 'Status post PCI to LAD (drug-eluting stent). Asymptomatic. Continue dual antiplatelet therapy for 12 months.' },
      { type: 'prescription', title: 'Antiplatelet', medication: 'Clopidogrel', dosage: '75 mg', frequency: 'Once daily', durationDays: 365 },
    ],
  },
  {
    by: 'dr.rohit',
    data: { name: 'Maddan', dob: '1983-06-05', gender: 'male', bloodGroup: 'AB+', phone: '9003011122', allergies: [] },
    records: [
      { type: 'lab', title: 'Thyroid panel', results: [
        { test: 'TSH', value: 7.8, unit: 'mIU/L', refRange: '0.4–4.0', flag: 'high' },
        { test: 'Free T4', value: 0.8, unit: 'ng/dL', refRange: '0.9–1.7', flag: 'low' } ] },
      { type: 'prescription', title: 'Thyroid replacement', medication: 'Levothyroxine', dosage: '50 mcg', frequency: 'Empty stomach, morning', durationDays: 90 },
    ],
  },
  {
    by: 'dr.varun',
    data: { name: 'Allan', dob: '1972-11-18', gender: 'male', bloodGroup: 'O-', phone: '9962033344', allergies: ['Aspirin'] },
    records: [
      { type: 'vitals', title: 'ER triage', heartRate: 118, systolic: 96, diastolic: 60, temperature: 38.9, spo2: 93, content: 'Fever, productive cough × 4 days.' },
      { type: 'lab', title: 'Sepsis screen', results: [
        { test: 'WBC', value: 16.4, unit: '10³/µL', refRange: '4–11', flag: 'high' },
        { test: 'Lactate', value: 2.6, unit: 'mmol/L', refRange: '< 2', flag: 'high' },
        { test: 'CRP', value: 148, unit: 'mg/L', refRange: '< 5', flag: 'critical' } ] },
      { type: 'note', title: 'Community-acquired pneumonia', content: 'CXR: right lower lobe consolidation. Started IV antibiotics after blood cultures. Admit to ward.' },
    ],
  },
  {
    by: 'dr.varun',
    data: { name: 'Ashwin', dob: '1999-03-14', gender: 'male', bloodGroup: 'B-', phone: '9500044455', allergies: [] },
    records: [
      { type: 'note', title: 'Road traffic accident — minor', content: 'Abrasions left forearm, no head injury, GCS 15. Wound cleaned and dressed. Tetanus toxoid given.' },
    ],
  },
  {
    by: 'dr.nikhil',
    data: { name: 'Ganesan', dob: '2001-08-09', gender: 'male', bloodGroup: 'A-', phone: '9840566677', allergies: ['Peanuts'] },
    records: [
      { type: 'vitals', title: 'Asthma review', heartRate: 84, systolic: 118, diastolic: 74, temperature: 36.9, spo2: 95 },
      { type: 'prescription', title: 'Reliever inhaler', medication: 'Salbutamol MDI', dosage: '100 mcg × 2 puffs', frequency: 'As needed', durationDays: 180 },
    ],
  },
  {
    by: 'dr.nikhil',
    data: { name: 'Pranav', dob: '1960-12-01', gender: 'male', bloodGroup: 'O+', phone: '9445077788', allergies: [] },
    records: [
      { type: 'lab', title: 'Diabetes monitoring', results: [
        { test: 'HbA1c', value: 8.4, unit: '%', refRange: '< 7', flag: 'high' },
        { test: 'Fasting glucose', value: 168, unit: 'mg/dL', refRange: '70–100', flag: 'high' },
        { test: 'Creatinine', value: 1.1, unit: 'mg/dL', refRange: '0.6–1.2', flag: 'normal' } ] },
      { type: 'prescription', title: 'Oral hypoglycaemic', medication: 'Metformin', dosage: '1000 mg', frequency: 'Twice daily with meals', durationDays: 90 },
    ],
  },
];

async function login(gw, username, password) {
  const r = await httpJson(`${gw}/api/auth/login`, { method: 'POST', body: { username, password } });
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status}`);
  return r.data.token;
}

export async function seed(gw) {
  const tokens = {};
  for (const u of ['dr.rohit', 'dr.varun', 'dr.nikhil']) tokens[u] = await login(gw, u, 'Doctor@123');
  const auth = (u) => ({ authorization: `Bearer ${tokens[u]}` });

  for (const p of PATIENTS) {
    const r = await httpJson(`${gw}/api/patients`, { method: 'POST', body: p.data, headers: auth(p.by), timeoutMs: 15000 });
    if (r.status !== 201) throw new Error(`register ${p.data.name}: ${r.status} ${JSON.stringify(r.data)}`);
    for (const rec of p.records) {
      const w = await httpJson(`${gw}/api/patients/${r.data.id}/records`, { method: 'POST', body: rec, headers: auth(p.by), timeoutMs: 15000 });
      if (w.status !== 201) throw new Error(`record for ${p.data.name}: ${w.status} ${JSON.stringify(w.data)}`);
    }
    console.log(`  seeded ${r.data.id} ${p.data.name.padEnd(10)} → ${r.data.shardId}`);
  }

  // Sanku also consents to Dr. Nikhil (general physician) — shows patient-granted consent.
  const sanku = await login(gw, 'sanku', 'Patient@123');
  const me = await httpJson(`${gw}/api/auth/me`, { headers: { authorization: `Bearer ${sanku}` } });
  await httpJson(`${gw}/api/patients/${me.data.user.patientId}/consents`, {
    method: 'POST',
    body: { doctorId: 'D-NIKHIL' },
    headers: { authorization: `Bearer ${sanku}` },
  });
  return { patients: PATIENTS.length };
}
