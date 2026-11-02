import { badRequest } from './errors';
import type { Body } from './server';

export function optionalInteger(body: Body, field: string, min: number, max: number, path = field): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(path, `${path} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function requiredInteger(body: Body, field: string, min: number, max: number, path = field): number {
  const value = optionalInteger(body, field, min, max, path);
  if (value === undefined) throw badRequest(path, `${path} is required (an integer from ${min} to ${max})`);
  return value;
}

export function requiredBoolean(body: Body, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') throw badRequest(field, `${field} must be true or false`);
  return value;
}

export function requiredString(body: Body, field: string, path = field): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(path, `${path} must be a non-empty string`);
  return value;
}

export function optionalString(body: Body, field: string, path = field): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(path, `${path} must be a string`);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(path, `${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
