import { z } from 'zod';

const MAX_AGE_YEARS = 130;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid calendar date');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(64, 'Password must be at most 64 characters')
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/\d/, 'Password needs a digit')
  .regex(/[^A-Za-z0-9]/, 'Password needs a special character');

export const usernameSchema = z
  .string()
  .min(3, 'Username must be 3-32 characters')
  .max(32, 'Username must be 3-32 characters')
  .regex(/^[a-z0-9._]+$/, 'Username may contain a-z, 0-9, dot and underscore');

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const patientSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Name must be 2-80 characters')
      .max(80, 'Name must be 2-80 characters')
      // \p{M} = combining marks: Tamil, Hindi, etc. need them (found by TC-VAL-NAME unicode test)
      .regex(/^[\p{L}\p{M} .'-]+$/u, 'Name contains invalid characters'),
    dob: isoDate,
    gender: z.enum(['male', 'female', 'other']),
    bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
    phone: z.string().regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number'),
    abhaId: z
      .string()
      .regex(/^\d{14}$/, 'ABHA number must be exactly 14 digits')
      .optional(),
    allergies: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    account: z.object({ username: usernameSchema, password: passwordSchema }).optional(),
  })
  .superRefine((p, ctx) => {
    const dob = new Date(p.dob);
    const today = new Date();
    if (dob > today) ctx.addIssue({ code: 'custom', path: ['dob'], message: 'Date of birth cannot be in the future' });
    const oldest = new Date(today);
    oldest.setFullYear(today.getFullYear() - MAX_AGE_YEARS);
    if (dob < oldest) ctx.addIssue({ code: 'custom', path: ['dob'], message: `Age cannot exceed ${MAX_AGE_YEARS} years` });
  });

const title = z.string().trim().min(3, 'Title must be 3-120 characters').max(120, 'Title must be 3-120 characters');

export const recordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('note'),
    title,
    content: z.string().trim().min(1, 'Note cannot be empty').max(5000, 'Note must be at most 5000 characters'),
  }),
  z.object({
    type: z.literal('lab'),
    title,
    content: z.string().max(2000).optional(),
    results: z
      .array(
        z.object({
          test: z.string().trim().min(1).max(60),
          value: z.number().finite(),
          unit: z.string().max(20).default(''),
          refRange: z.string().max(40).optional(),
          flag: z.enum(['normal', 'low', 'high', 'critical']).default('normal'),
        }),
      )
      .min(1, 'At least one lab result is required')
      .max(30),
  }),
  z.object({
    type: z.literal('prescription'),
    title,
    medication: z.string().trim().min(2).max(100),
    dosage: z.string().trim().min(1).max(50),
    frequency: z.string().trim().min(1).max(50),
    durationDays: z.number().int().min(1, 'Duration must be 1-365 days').max(365, 'Duration must be 1-365 days'),
    content: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('vitals'),
    title,
    heartRate: z.number().int().min(20).max(250),
    systolic: z.number().int().min(50).max(260),
    diastolic: z.number().int().min(30).max(160),
    temperature: z.number().min(30).max(45),
    spo2: z.number().int().min(50).max(100),
    content: z.string().max(2000).optional(),
  }),
]).superRefine((v, ctx) => {
  if (v.type === 'vitals' && v.diastolic >= v.systolic) {
    ctx.addIssue({ code: 'custom', path: ['diastolic'], message: 'Diastolic must be lower than systolic' });
  }
});

export const breakGlassSchema = z.object({
  reason: z.string().trim().min(10, 'Give a clinical reason of at least 10 characters').max(500),
});

export const consentSchema = z.object({ doctorId: z.string().min(1).max(64) });

/** Parse or throw a 400-shaped error the gateway turns into a response. */
export function validate(schema, input) {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const err = new Error('Validation failed');
  err.status = 400;
  err.code = 'VALIDATION_ERROR';
  err.details = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw err;
}
