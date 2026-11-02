import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const KEYBOARD = '/v1/devices/default/keyboard';

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

function keyboardReply(text: string) {
  return {
    body: { ok: true, keyboard: { focus: 'focused', text }, state: livingRoomState({ keyboard: { focus: 'focused', text } }) },
  };
}

describe('fill, type and clear', () => {
  it('fill replaces the text field content', async () => {
    api.on('POST', KEYBOARD, keyboardReply('stranger things'));

    const result = await sandbox.run(['fill', 'stranger things']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`keyboard: "stranger things"\n`);
    expect(api.requests[0]?.body).toEqual({ op: 'set', text: 'stranger things' });
  });

  it('type appends, joining several arguments with spaces', async () => {
    api.on('POST', KEYBOARD, keyboardReply('stranger things'));

    const result = await sandbox.run(['type', 'stranger', 'things']);

    expect(result.stdout).toBe(`keyboard: "stranger things"\n`);
    expect(api.requests[0]?.body).toEqual({ op: 'append', text: 'stranger things' });
  });

  it('type accepts text that starts with a dash after --', async () => {
    api.on('POST', KEYBOARD, keyboardReply('-x'));

    await sandbox.run(['type', '--', '-x']);

    expect(api.requests[0]?.body).toEqual({ op: 'append', text: '-x' });
  });

  it('clear empties the field', async () => {
    api.on('POST', KEYBOARD, keyboardReply(''));

    const result = await sandbox.run(['clear']);

    expect(result.stdout).toBe(`keyboard: ""\n`);
    expect(api.requests[0]?.body).toEqual({ op: 'clear' });
  });

  it('exits 6 when no text field is focused', async () => {
    api.on('POST', KEYBOARD, {
      status: 409,
      body: apiError('KEYBOARD_NOT_FOCUSED', 'No text field is focused on Living Room', 'Navigate to a text field'),
    });

    const result = await sandbox.run(['fill', 'abc']);

    expect(result.code).toBe(6);
  });

  it('fill and type need text', async () => {
    expect((await sandbox.run(['fill'])).code).toBe(2);
    expect((await sandbox.run(['type'])).code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });
});
