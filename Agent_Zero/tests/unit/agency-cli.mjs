import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgencyEnv, COPILOT_EFFORT, COPILOT_MODEL } from '../../brain/agency-cli.js';

test('buildAgencyEnv strips parent session ids from child environment', () => {
  const baseEnv = {
    PATH: 'C:\\Tools',
    AGENCY_SESSION_ID: 'parent-agency-session',
    COPILOT_AGENT_SESSION_ID: 'parent-copilot-session',
    COPILOT_MODEL: 'caller-model',
    KEEP_ME: 'yes'
  };

  const env = buildAgencyEnv(baseEnv);

  assert.equal(env.PATH, 'C:\\Tools');
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.COPILOT_MODEL, COPILOT_MODEL);
  assert.equal(env.COPILOT_EFFORT, COPILOT_EFFORT);
  assert.equal(COPILOT_EFFORT, process.env.AGENT_ZERO_BRAIN_EFFORT || 'xhigh');
  assert.equal(Object.hasOwn(env, 'AGENCY_SESSION_ID'), false);
  assert.equal(Object.hasOwn(env, 'COPILOT_AGENT_SESSION_ID'), false);
  assert.equal(baseEnv.AGENCY_SESSION_ID, 'parent-agency-session');
  assert.equal(baseEnv.COPILOT_AGENT_SESSION_ID, 'parent-copilot-session');
});
