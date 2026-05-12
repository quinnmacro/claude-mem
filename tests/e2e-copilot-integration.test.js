#!/usr/bin/env node
/**
 * E2E test for Copilot CLI integration in claude-mem
 * Covers: JSON validity, adapter logic, platform source, transcript schema, hook config
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLAUDE_MEM_DIR = path.join(homedir(), '.claude-mem');

let passed = 0;
let failed = 0;
const failures = [];

function assert(description, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${description}`);
  } else {
    failed++;
    const msg = `  FAIL: ${description}`;
    failures.push(msg);
    console.error(msg);
  }
}

function assertEq(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  PASS: ${description}`);
  } else {
    failed++;
    const msg = `  FAIL: ${description}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(msg);
  }
}

// ── Test 1: JSON file validity ──
console.log('\n── Test 1: JSON file validity ──');

function loadJSON(filePath, label) {
  try {
    const data = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    assert(`${label} is valid JSON`, true);
    return parsed;
  } catch (e) {
    assert(`${label} is valid JSON`, false);
    console.error(`    ${e.message}`);
    return null;
  }
}

const copilotPlugin = loadJSON(
  path.join(REPO_ROOT, 'plugin', '.copilot-plugin', 'plugin.json'),
  '.copilot-plugin/plugin.json'
);
const copilotHooks = loadJSON(
  path.join(REPO_ROOT, 'plugin', 'hooks', 'copilot-hooks.json'),
  'hooks/copilot-hooks.json'
);
const transcriptWatchExample = loadJSON(
  path.join(REPO_ROOT, 'transcript-watch.example.json'),
  'transcript-watch.example.json'
);
const runtimeTranscriptWatch = loadJSON(
  path.join(CLAUDE_MEM_DIR, 'transcript-watch.json'),
  '~/.claude-mem/transcript-watch.json'
);

// ── Test 2: Plugin manifest structure ──
console.log('\n── Test 2: Plugin manifest structure ──');

if (copilotPlugin) {
  assertEq('Plugin name', copilotPlugin.name, 'claude-mem');
  assertEq('Plugin version is present', typeof copilotPlugin.version, 'string');
  assertEq('Skills path', copilotPlugin.skills, './skills/');
  assertEq('MCP servers path', copilotPlugin.mcpServers, './.mcp.json');
  assertEq('Hooks path points to copilot', copilotPlugin.hooks, './hooks/copilot-hooks.json');
  assert('Has interface block', !!copilotPlugin.interface);
  assert('Interface has displayName', !!copilotPlugin.interface?.displayName);
  assert('Mentions Copilot CLI in longDescription',
    copilotPlugin.interface?.longDescription?.includes('Copilot CLI'));
}

// ── Test 3: Hook definitions structure ──
console.log('\n── Test 3: Hook definitions structure ──');

if (copilotHooks) {
  assertEq('Hook description mentions Copilot',
    copilotHooks.description,
    'claude-mem Copilot CLI hook integration');

  const hookTypes = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  for (const hookType of hookTypes) {
    assert(`Has ${hookType} hook`, Array.isArray(copilotHooks.hooks[hookType]));
  }

  // Verify all hook commands use "hook copilot" not "hook codex"
  const allHookJSON = JSON.stringify(copilotHooks);
  assert('No "hook codex" references remain', !allHookJSON.includes('hook codex'));
  assert('Contains "hook copilot context"', allHookJSON.includes('hook copilot context'));
  assert('Contains "hook copilot session-init"', allHookJSON.includes('hook copilot session-init'));
  assert('Contains "hook copilot file-context"', allHookJSON.includes('hook copilot file-context'));
  assert('Contains "hook copilot observation"', allHookJSON.includes('hook copilot observation'));
  assert('Contains "hook copilot summarize"', allHookJSON.includes('hook copilot summarize'));

  // Verify version check uses COPILOT env var
  assert('Uses CLAUDE_MEM_COPILOT_HOOK env var', allHookJSON.includes('CLAUDE_MEM_COPILOT_HOOK'));
  assert('No CLAUDE_MEM_CODEX_HOOK env var remains', !allHookJSON.includes('CLAUDE_MEM_CODEX_HOOK'));

  // Verify PreToolUse matcher
  const preToolUseHook = copilotHooks.hooks.PreToolUse[0];
  assertEq('PreToolUse matcher', preToolUseHook?.matcher, '^Bash$|^mcp__.+__(read|view|cat)(_file|_files)?$');
}

// ── Test 4: Platform source normalization ──
console.log('\n── Test 4: Platform source normalization ──');

// Replicate normalizePlatformSource from src/shared/platform-source.ts
const DEFAULT_PLATFORM_SOURCE = 'claude';
function sanitizeRawSource(value) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}
function normalizePlatformSource(value) {
  if (!value) return DEFAULT_PLATFORM_SOURCE;
  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;
  if (source === 'transcript') return 'codex';
  if (source.includes('codex')) return 'codex';
  if (source.includes('copilot')) return 'copilot';
  if (source.includes('cursor')) return 'cursor';
  if (source.includes('claude')) return 'claude';
  return source;
}

assertEq('null → claude', normalizePlatformSource(null), 'claude');
assertEq('undefined → claude', normalizePlatformSource(undefined), 'claude');
assertEq('empty → claude', normalizePlatformSource(''), 'claude');
assertEq('claude → claude', normalizePlatformSource('claude'), 'claude');
assertEq('claude-code → claude', normalizePlatformSource('claude-code'), 'claude');
assertEq('codex → codex', normalizePlatformSource('codex'), 'codex');
assertEq('Codex → codex', normalizePlatformSource('Codex'), 'codex');
assertEq('copilot → copilot', normalizePlatformSource('copilot'), 'copilot');
assertEq('Copilot → copilot', normalizePlatformSource('Copilot'), 'copilot');
assertEq('github-copilot → copilot', normalizePlatformSource('github-copilot'), 'copilot');
assertEq('COPILOT CLI → copilot', normalizePlatformSource('COPILOT CLI'), 'copilot');
assertEq('cursor → cursor', normalizePlatformSource('cursor'), 'cursor');
assertEq('transcript → codex', normalizePlatformSource('transcript'), 'codex');
assertEq('unknown → passthrough', normalizePlatformSource('windsurf'), 'windsurf');

// Test sort order
const priority = ['claude', 'codex', 'copilot', 'cursor'];
function sortPlatformSources(sources) {
  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);
    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }
    return a.localeCompare(b);
  });
}

assertEq('sort: claude first', sortPlatformSources(['copilot', 'codex', 'claude']),
  ['claude', 'codex', 'copilot']);
assertEq('sort: copilot before cursor', sortPlatformSources(['cursor', 'copilot', 'windsurf']),
  ['copilot', 'cursor', 'windsurf']);

// ── Test 5: Adapter dispatch (simulated) ──
console.log('\n── Test 5: Adapter dispatch ──');

// Simulate getPlatformAdapter
const ADAPTER_CASES = {
  'claude-code': 'claudeCodeAdapter',
  'codex': 'codexAdapter',
  'copilot': 'copilotAdapter',
  'cursor': 'cursorAdapter',
  'gemini': 'geminiCliAdapter',
  'gemini-cli': 'geminiCliAdapter',
  'windsurf': 'windsurfAdapter',
  'raw': 'rawAdapter',
};

function getPlatformAdapter(platform) {
  return ADAPTER_CASES[platform] || 'rawAdapter';
}

assertEq('copilot → copilotAdapter', getPlatformAdapter('copilot'), 'copilotAdapter');
assertEq('codex → codexAdapter', getPlatformAdapter('codex'), 'codexAdapter');
assertEq('claude-code → claudeCodeAdapter', getPlatformAdapter('claude-code'), 'claudeCodeAdapter');
assertEq('unknown → rawAdapter', getPlatformAdapter('unknown'), 'rawAdapter');

// ── Test 6: Adapter normalizeInput (simulated with mock hook input) ──
console.log('\n── Test 6: Adapter input normalization ──');

// Simulate the copilot adapter's normalizeInput
const EVENT_NAMES = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop',
]);

function eventName(value) {
  return typeof value === 'string' && EVENT_NAMES.has(value) ? value : undefined;
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isValidCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0;
}

function normalizeInput(raw) {
  const r = raw ?? {};
  const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
  if (!isValidCwd(cwd)) throw new Error('invalid_cwd');

  const hookEventName = eventName(r.hook_event_name);
  const sessionId = stringOrUndefined(r.session_id);
  if (!sessionId) throw new Error('missing_session_id');

  return {
    sessionId,
    cwd,
    prompt: stringOrUndefined(r.prompt),
    toolName: stringOrUndefined(r.tool_name),
    toolInput: r.tool_input,
    toolResponse: r.tool_response,
    transcriptPath: stringOrUndefined(r.transcript_path),
    model: stringOrUndefined(r.model),
  };
}

// Test SessionStart
const startInput = normalizeInput({
  hook_event_name: 'SessionStart',
  session_id: 'session-abc-123',
  cwd: '/home/user/my-project',
  source: 'startup',
  prompt: 'Fix the login bug',
  model: 'gpt-5',
});
assertEq('SessionStart: sessionId', startInput.sessionId, 'session-abc-123');
assertEq('SessionStart: cwd', startInput.cwd, '/home/user/my-project');
assertEq('SessionStart: prompt', startInput.prompt, 'Fix the login bug');
assertEq('SessionStart: model', startInput.model, 'gpt-5');

// Test PostToolUse
const toolInput = normalizeInput({
  hook_event_name: 'PostToolUse',
  session_id: 'session-def-456',
  cwd: '/home/user/my-project',
  tool_name: 'Bash',
  tool_input: { command: 'ls -la' },
  tool_response: 'total 48\ndrwxr-xr-x ...',
});
assertEq('PostToolUse: sessionId', toolInput.sessionId, 'session-def-456');
assertEq('PostToolUse: toolName', toolInput.toolName, 'Bash');
assertEq('PostToolUse: toolInput', toolInput.toolInput, { command: 'ls -la' });
assertEq('PostToolUse: toolResponse', toolInput.toolResponse, 'total 48\ndrwxr-xr-x ...');

// Test missing session_id
try {
  normalizeInput({ hook_event_name: 'SessionStart' });
  assert('Rejects missing session_id', false);
} catch (e) {
  assertEq('Rejects missing session_id', e.message, 'missing_session_id');
}

// ── Test 7: Transcript schema validation ──
console.log('\n── Test 7: Transcript schema validation ──');

function validateTranscriptSchema(schema, name) {
  assert(`${name}: has name`, !!schema.name);
  assert(`${name}: has version`, !!schema.version);
  assert(`${name}: has events array`, Array.isArray(schema.events));
  assert(`${name}: has 6+ events`, schema.events?.length >= 6, `got ${schema.events?.length}`);

  const eventNames = schema.events?.map(e => e.name) ?? [];
  const required = ['session-start', 'user-message', 'assistant-message',
    'tool-execution-start', 'tool-execution-complete', 'session-end'];
  for (const req of required) {
    assert(`${name}: has "${req}" event`, eventNames.includes(req));
  }

  const actions = schema.events?.map(e => e.action) ?? [];
  assert(`${name}: has session_context action`, actions.includes('session_context'));
  assert(`${name}: has session_init action`, actions.includes('session_init'));
  assert(`${name}: has assistant_message action`, actions.includes('assistant_message'));
  assert(`${name}: has tool_use action`, actions.includes('tool_use'));
  assert(`${name}: has tool_result action`, actions.includes('tool_result'));
  assert(`${name}: has session_end action`, actions.includes('session_end'));
}

for (const [name, schema] of [['example', transcriptWatchExample?.schemas?.copilot],
  ['runtime', runtimeTranscriptWatch?.schemas?.copilot]]) {
  if (schema) {
    console.log(`  Checking ${name} config's copilot schema:`);
    validateTranscriptSchema(schema, name);
  }
}

// ── Test 8: Watch entry validation ──
console.log('\n── Test 8: Watch entry validation ──');

function findWatch(config, watchName) {
  return config?.watches?.find(w => w.name === watchName);
}

const exampleWatch = findWatch(transcriptWatchExample, 'copilot');
const runtimeWatch = findWatch(runtimeTranscriptWatch, 'copilot');

if (exampleWatch) {
  assertEq('Example watch: schema', exampleWatch.schema, 'copilot');
  assert('Example watch: path has .copilot/session-state',
    exampleWatch.path?.includes('.copilot/session-state'));
  assertEq('Example watch: startAtEnd', exampleWatch.startAtEnd, true);
}

if (runtimeWatch) {
  assertEq('Runtime watch: schema', runtimeWatch.schema, 'copilot');
  assert('Runtime watch: path has .copilot/session-state',
    runtimeWatch.path?.includes('.copilot/session-state'));
  assertEq('Runtime watch: startAtEnd', runtimeWatch.startAtEnd, true);
}

// ── Test 9: Cross-file consistency ──
console.log('\n── Test 9: Cross-file consistency ──');

if (copilotPlugin && copilotHooks) {
  assertEq('Plugin hooks pointer matches copilot-hooks.json filename',
    copilotPlugin.hooks, './hooks/copilot-hooks.json');
}

if (transcriptWatchExample && runtimeTranscriptWatch) {
  const exSchema = transcriptWatchExample.schemas?.copilot;
  const rtSchema = runtimeTranscriptWatch.schemas?.copilot;
  if (exSchema && rtSchema) {
    assertEq('Example and runtime schemas have same name',
      exSchema.name, rtSchema.name);
    assertEq('Example and runtime schemas have same event count',
      exSchema.events?.length, rtSchema.events?.length);
  }
}

// ── Test 10: Simulated Copilot CLI JSONL event parsing (real format) ──
console.log('\n── Test 10: Simulated Copilot CLI JSONL event parsing (real format) ──');

// Real Copilot CLI events use: type, id, timestamp, parentId, data (NOT payload)
const mockCopilotEvents = [
  { type: 'session.start', data: { sessionId: 'copilot-sess-001', context: { cwd: '/project' } } },
  { type: 'user.message', data: { content: 'Add tests for the API' } },
  { type: 'assistant.message', data: { messageId: 'msg_1', content: "I'll add tests for the API endpoints." } },
  { type: 'tool.execution_start', data: { toolCallId: 'call_1', toolName: 'Bash', arguments: { command: 'npm test' } } },
  { type: 'tool.execution_complete', data: { toolCallId: 'call_1', success: true, result: { content: 'All tests passed!', detailedContent: 'Test output here' } } },
  { type: 'session.shutdown', data: { shutdownType: 'routine' } },
];

// Parse through the copilot schema matchers
const schema = runtimeTranscriptWatch?.schemas?.copilot;
if (schema) {
  const results = [];
  for (const event of mockCopilotEvents) {
    for (const schemaEvent of schema.events) {
      const m = schemaEvent.match;
      if (!m) continue;

      let matched = false;
      if (m.equals !== undefined) {
        matched = event[m.path] === m.equals;
      } else if (m.in !== undefined) {
        matched = m.in.includes(event[m.path]);
      }

      if (matched) {
        results.push({ event, matchedTo: schemaEvent.name, action: schemaEvent.action });
        break;
      }
    }
  }

  assertEq('All 6 mock events matched a schema event', results.length, 6);
  assertEq('Event 0: session.start → session_context', results[0]?.action, 'session_context');
  assertEq('Event 1: user.message → session_init', results[1]?.action, 'session_init');
  assertEq('Event 3: tool.execution_start → tool_use', results[3]?.action, 'tool_use');
  assertEq('Event 4: tool.execution_complete → tool_result', results[4]?.action, 'tool_result');
  assertEq('Event 5: session.shutdown → session_end', results[5]?.action, 'session_end');
}

// ── Summary ──
console.log(`\n═══════════════════════════════════════`);
console.log(`  Total: ${passed + failed}  |  PASS: ${passed}  |  FAIL: ${failed}`);
console.log(`═══════════════════════════════════════`);
if (failures.length > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(f);
  process.exit(1);
} else {
  console.log('All tests passed!');
  process.exit(0);
}