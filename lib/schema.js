'use strict';

// Validation for service records: the seed file (data/services.json) and the
// bodies of POST/PUT /api/services.
//
// STAND-IN FOR ZOD. zod could not be installed from its GitHub repo: the repo
// holds TypeScript source (v4 is a pnpm workspace, v3 has no built lib/), and
// JavaScript is produced only at publish time. This module mimics the subset
// of zod's API the app uses — `schema.parse(x)` and `schema.safeParse(x)` with
// `{ success, data, error.issues }` — so callers do not change when zod becomes
// installable. The intended replacement is:
//
//   const { z } = require('zod');
//   const serviceSchema = z.object({
//     name:   z.string().trim().min(1).max(120),
//     owner:  z.string().trim().min(1).max(80),
//     status: z.enum(STATUSES)
//   }).strict();
//   const servicesFileSchema = z.array(serviceSchema).min(1);

const STATUSES = ['healthy', 'degraded', 'maintenance'];

const LIMITS = { name: 120, owner: 80 };

class ValidationError extends Error {
  constructor(issues) {
    super(issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function makeSchema(check) {
  return {
    safeParse(input) {
      const issues = [];
      const data = check(input, [], issues);
      return issues.length
        ? { success: false, error: new ValidationError(issues) }
        : { success: true, data };
    },
    parse(input) {
      const result = this.safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    }
  };
}

function trimmedString(value, path, issues, max) {
  if (typeof value !== 'string') {
    issues.push({ path, message: 'expected a string' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) issues.push({ path, message: 'must not be empty' });
  if (trimmed.length > max) issues.push({ path, message: `must be at most ${max} characters` });
  return trimmed;
}

const serviceSchema = makeSchema((input, path, issues) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    issues.push({ path, message: 'expected an object' });
    return undefined;
  }
  const out = {
    name: trimmedString(input.name, [...path, 'name'], issues, LIMITS.name),
    owner: trimmedString(input.owner, [...path, 'owner'], issues, LIMITS.owner)
  };
  if (STATUSES.includes(input.status)) {
    out.status = input.status;
  } else {
    issues.push({ path: [...path, 'status'], message: `expected one of: ${STATUSES.join(', ')}` });
  }
  for (const key of Object.keys(input)) {
    if (key !== 'name' && key !== 'owner' && key !== 'status') {
      issues.push({ path: [...path, key], message: 'unrecognized key' });
    }
  }
  return out;
});

const servicesFileSchema = makeSchema((input, path, issues) => {
  if (!Array.isArray(input)) {
    issues.push({ path, message: 'expected an array of services' });
    return undefined;
  }
  if (input.length === 0) issues.push({ path, message: 'must contain at least one service' });
  return input.map((item, i) => {
    const result = serviceSchema.safeParse(item);
    if (result.success) return result.data;
    for (const issue of result.error.issues) issues.push({ ...issue, path: [...path, i, ...issue.path] });
    return undefined;
  });
});

module.exports = { STATUSES, ValidationError, serviceSchema, servicesFileSchema };
