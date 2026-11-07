import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const { schema } = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'config.schema.json'), 'utf8')) as {
  schema: object;
};

// Mirrors the Homebridge verification checks: AJV 8 with strict mode off.
const compile = () => new Ajv({ strict: false, allErrors: true }).compile(schema);

describe('config schema (P6)', () => {
  it('compiles as a JSON Schema the way the Homebridge verification checks do', () => {
    expect(compile).not.toThrow();
  });

  it('accepts a config with a name and a device id', () => {
    expect(compile()({ platform: 'AgentATV', name: 'Agent ATV', devices: [{ id: 'AABBCCDDEEFF' }] })).toBe(true);
  });

  it('rejects a config without a name', () => {
    expect(compile()({ platform: 'AgentATV' })).toBe(false);
  });

  it('rejects a device entry without an id', () => {
    expect(compile()({ name: 'Agent ATV', devices: [{ name: 'Living room' }] })).toBe(false);
  });
});
