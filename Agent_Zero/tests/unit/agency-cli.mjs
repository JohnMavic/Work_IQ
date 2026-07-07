import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgencyArgs,
  buildAgencyEnv,
  COPILOT_EFFORT,
  COPILOT_MODEL,
  disabledMcpServersForMode,
  resolveAgencyEffort
} from '../../brain/agency-cli.js';

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

test('agency effort mapping keeps scans and gateway xhigh while chat defaults high', () => {
  assert.equal(resolveAgencyEffort({
    runClass: 'background',
    env: {}
  }), 'xhigh');
  assert.equal(resolveAgencyEffort({
    runClass: 'interactive',
    env: {}
  }), 'high');
  assert.equal(resolveAgencyEffort({
    runClass: 'interactive',
    env: { AGENT_ZERO_CHAT_EFFORT: 'medium', AGENT_ZERO_BRAIN_EFFORT: 'max' }
  }), 'medium');
  assert.equal(resolveAgencyEffort({
    runClass: 'background',
    env: { AGENT_ZERO_CHAT_EFFORT: 'medium', AGENT_ZERO_BRAIN_EFFORT: 'max' }
  }), 'max');

  const env = buildAgencyEnv({}, { effort: 'high' });
  assert.equal(env.COPILOT_EFFORT, 'high');

  const args = buildAgencyArgs({
    bootstrap: 'prompt',
    effort: 'high',
    callerArgs: ['--no-default-mcps', '--disable-mcp-server', 'workiq', '--disable-mcp-server=mail'],
    mcpMode: 'default',
    disableMcpServers: disabledMcpServersForMode('default', {})
  });
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.equal(args.includes('--no-default-mcps'), false);
  assert.equal(args.includes('--disable-mcp-server'), false);
  assert.equal(args.includes('--disable-mcp-server=mail'), false);
  assert.equal(args.includes('--disable-builtin-mcps'), false);
  assert.equal(args.includes('--no-config-plugins'), false);
  assert.equal(args.includes('workiq'), false);

  const noMcpArgs = buildAgencyArgs({
    bootstrap: 'prompt',
    effort: 'high',
    mcpMode: 'none',
    disableMcpServers: disabledMcpServersForMode('none', {})
  });
  assert.equal(noMcpArgs.includes('--disable-builtin-mcps'), true);
  assert.equal(noMcpArgs.includes('--no-config-plugins'), true);
  assert.equal(noMcpArgs.includes('--disable-mcp-server'), false);
  assert.equal(noMcpArgs.includes('workiq'), false);
});
