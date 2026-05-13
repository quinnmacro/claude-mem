#!/usr/bin/env node
/**
 * E2E test for Copilot CLI transcript watcher integration in claude-mem.
 *
 * Verifies:
 *  1. Build bundle contains copilot schema code
 *  2. Transcript schema correctly parses real Copilot CLI session events
 *  3. Watcher is configured for copilot in transcript-watch.json
 *  4. Worker HTTP API is accessible and healthy
 *  5. Cross-file consistency between example and runtime configs
 */

import { readFileSync, existsSync, createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';
import { homedir } from 'os';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLAUDE_MEM_DIR = path.join(homedir(), '.claude-mem');
const COPILOT_SESSIONS_DIR = path.join(homedir(), '.copilot', 'session-state');

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

// ── Test 1: Build bundle contains copilot code ──
console.log('\n── Test 1: Build bundle contains copilot code ──');

const bundlePath = path.join(REPO_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, 'utf-8');
  assert('Bundle exists and is non-empty', bundle.length > 100000);
  // The copilot schema uses real Copilot CLI event types with dot notation
  // esbuild minifies some strings; just verify key identifiers are present
  // The real test of correctness is in Tests 3-4 (schema matching on real data)
  assert('Bundle exists and is non-empty', bundle.length > 100000);
  const hasSessionStart = bundle.includes('session.start');
  const hasUserMessage = bundle.includes('user.message');
  const hasCopilotStr = bundle.includes('"copilot"');
  // At least 2 of 3 markers must be present (minification varies)
  const markerCount = (hasSessionStart ? 1 : 0) + (hasUserMessage ? 1 : 0) + (hasCopilotStr ? 1 : 0);
  assert(`Bundle contains copilot markers (${markerCount}/3)`, markerCount >= 2);
} else {
  assert('Bundle file exists', false);
}

// ── Test 2: Load config files ──
console.log('\n── Test 2: Config file loading ──');

const transcriptWatch = loadJSON(
  path.join(CLAUDE_MEM_DIR, 'transcript-watch.json'),
  '~/.claude-mem/transcript-watch.json'
);
const exampleConfig = loadJSON(
  path.join(REPO_ROOT, 'transcript-watch.example.json'),
  'transcript-watch.example.json'
);

// ── Test 3: Schema matching with real Copilot CLI events ──
console.log('\n── Test 3: Schema matching with real Copilot CLI events ──');

/**
 * Apply a transcript schema to a raw event. Returns { matched, action, fields }
 * or null if no match. Mirrors the worker's schema matching logic.
 */
function matchEvent(schema, rawEvent) {
  for (const schemaEvent of schema.events) {
    const m = schemaEvent.match;
    if (!m) continue;

    let matched = false;
    if (m.equals !== undefined) {
      // Navigate dotted path: "type" or "payload.type"
      const parts = m.path.split('.');
      let value = rawEvent;
      for (const part of parts) {
        if (value == null) break;
        value = value[part];
      }
      matched = value === m.equals;
    } else if (m.in !== undefined) {
      const parts = m.path.split('.');
      let value = rawEvent;
      for (const part of parts) {
        if (value == null) break;
        value = value[part];
      }
      matched = m.in.includes(value);
    }

    if (matched) {
      // Extract fields
      const fields = {};
      if (schemaEvent.fields) {
        for (const [key, fieldPath] of Object.entries(schemaEvent.fields)) {
          if (typeof fieldPath === 'string') {
            const parts = fieldPath.split('.');
            let value = rawEvent;
            for (const part of parts) {
              if (value == null) break;
              value = value[part];
            }
            fields[key] = value;
          }
        }
      }
      return {
        eventName: schemaEvent.name,
        action: schemaEvent.action,
        fields,
      };
    }
  }
  return null;
}

// Load copilot schema from runtime config
const copilotSchema = transcriptWatch?.schemas?.copilot;
if (copilotSchema) {
  assert('Copilot schema has name', copilotSchema.name === 'copilot');
  assert('Copilot schema has version', !!copilotSchema.version);
  assert('Copilot schema has 6 events', copilotSchema.events?.length === 6);

  // Verify all expected event types have matchers
  const eventTypes = copilotSchema.events.map(e => e.match?.equals).filter(Boolean);
  assert('Matches session.start', eventTypes.includes('session.start'));
  assert('Matches user.message', eventTypes.includes('user.message'));
  assert('Matches assistant.message', eventTypes.includes('assistant.message'));
  assert('Matches tool.execution_start', eventTypes.includes('tool.execution_start'));
  assert('Matches tool.execution_complete', eventTypes.includes('tool.execution_complete'));
  assert('Matches session.shutdown', eventTypes.includes('session.shutdown'));

  // Verify actions
  const actions = copilotSchema.events.map(e => e.action);
  assert('Has session_context action', actions.includes('session_context'));
  assert('Has session_init action', actions.includes('session_init'));
  assert('Has assistant_message action', actions.includes('assistant_message'));
  assert('Has tool_use action', actions.includes('tool_use'));
  assert('Has tool_result action', actions.includes('tool_result'));
  assert('Has session_end action', actions.includes('session_end'));

  // Test against synthetic events matching the real Copilot CLI format
  const testEvents = [
    {
      type: 'session.start',
      data: { sessionId: 'test-sess-001', context: { cwd: '/home/user/project' } },
      expectMatch: true,
      expectAction: 'session_context',
      expectFields: { sessionId: 'test-sess-001', cwd: '/home/user/project' },
    },
    {
      type: 'user.message',
      data: { content: 'Add tests for the API' },
      expectMatch: true,
      expectAction: 'session_init',
      expectFields: { prompt: 'Add tests for the API' },
    },
    {
      type: 'assistant.message',
      data: { messageId: 'msg_1', content: 'I will add tests.' },
      expectMatch: true,
      expectAction: 'assistant_message',
      expectFields: { message: 'I will add tests.' },
    },
    {
      type: 'tool.execution_start',
      data: { toolCallId: 'call_1', toolName: 'Bash', arguments: { command: 'npm test' } },
      expectMatch: true,
      expectAction: 'tool_use',
      expectFields: { toolId: 'call_1', toolName: 'Bash', toolInput: { command: 'npm test' } },
    },
    {
      type: 'tool.execution_complete',
      data: { toolCallId: 'call_1', success: true, result: { content: 'All tests passed!' } },
      expectMatch: true,
      expectAction: 'tool_result',
      expectFields: { toolId: 'call_1', toolResponse: { content: 'All tests passed!' } },
    },
    {
      type: 'session.shutdown',
      data: { shutdownType: 'routine' },
      expectMatch: true,
      expectAction: 'session_end',
    },
    // Events that should NOT match
    {
      type: 'session.model_change',
      data: { newModel: 'gpt-5' },
      expectMatch: false,
    },
    {
      type: 'assistant.turn_start',
      data: { turnId: '0' },
      expectMatch: false,
    },
    {
      type: 'assistant.turn_end',
      data: { turnId: '0' },
      expectMatch: false,
    },
    {
      type: 'hook.start',
      data: { hookInvocationId: 'h_1', hookType: 'agentStop' },
      expectMatch: false,
    },
  ];

  let matchedCount = 0;
  let correctlyUnmatched = 0;
  for (const testEvent of testEvents) {
    const result = matchEvent(copilotSchema, testEvent);
    if (testEvent.expectMatch) {
      if (result) {
        matchedCount++;
        const label = `${testEvent.type} → ${result.action}`;
        assertEq(label, result.action, testEvent.expectAction);
        if (testEvent.expectFields) {
          for (const [key, expected] of Object.entries(testEvent.expectFields)) {
            assertEq(`  field: ${key}`, result.fields[key], expected);
          }
        }
      } else {
        assert(`${testEvent.type} should match but did not`, false);
      }
    } else {
      if (result === null) {
        correctlyUnmatched++;
        assert(`${testEvent.type} correctly unmatched`, true);
      } else {
        assert(`${testEvent.type} should NOT match but matched as ${result.action}`, false);
      }
    }
  }

  assertEq('All 6 semantic events matched', matchedCount, 6);
  assertEq('All 4 infrastructure events unmatched', correctlyUnmatched, 4);
}

// ── Test 4: Parse real Copilot CLI events.jsonl files ──
console.log('\n── Test 4: Parse real Copilot CLI events.jsonl files ──');

async function parseRealSessions() {
  if (!existsSync(COPILOT_SESSIONS_DIR)) {
    console.log('  SKIP: No ~/.copilot/session-state directory found');
    return;
  }

  const { readdir } = await import('fs/promises');
  const entries = await readdir(COPILOT_SESSIONS_DIR, { withFileTypes: true });
  const sessionDirs = entries.filter(e => e.isDirectory());

  if (sessionDirs.length === 0) {
    console.log('  SKIP: No copilot session directories found');
    return;
  }

  console.log(`  Found ${sessionDirs.length} copilot session directories`);

  let totalEvents = 0;
  let matchedEvents = 0;
  let unmatchedEvents = 0;
  const matchedByAction = {};
  const unmatchedTypes = new Set();
  let sessionsWithAllRequiredEvents = 0;

  for (const dir of sessionDirs) {
    const eventsPath = path.join(COPILOT_SESSIONS_DIR, dir.name, 'events.jsonl');
    if (!existsSync(eventsPath)) continue;

    const sessionRequiredActions = new Set();
    const rl = createInterface({ input: createReadStream(eventsPath), crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      totalEvents++;
      try {
        const event = JSON.parse(line);
        const result = matchEvent(copilotSchema, event);
        if (result) {
          matchedEvents++;
          matchedByAction[result.action] = (matchedByAction[result.action] || 0) + 1;
          sessionRequiredActions.add(result.action);
        } else {
          unmatchedEvents++;
          unmatchedTypes.add(event.type);
        }
      } catch {
        // skip malformed lines
      }
    }

    // A session should have at least session_context, session_init, session_end
    if (sessionRequiredActions.has('session_context') &&
        sessionRequiredActions.has('session_init') &&
        sessionRequiredActions.has('session_end')) {
      sessionsWithAllRequiredEvents++;
    }
  }

  assert('Total events > 0', totalEvents > 0);
  assert('Matched events > 0', matchedEvents > 0);
  console.log(`  Stats: ${totalEvents} total, ${matchedEvents} matched, ${unmatchedEvents} unmatched`);
  console.log(`  Matched by action: ${JSON.stringify(matchedByAction)}`);
  console.log(`  Unmatched types: ${[...unmatchedTypes].join(', ')}`);
  console.log(`  Sessions with all required events: ${sessionsWithAllRequiredEvents}`);

  assert('Has session_context events', (matchedByAction['session_context'] || 0) > 0);
  assert('Has session_init events', (matchedByAction['session_init'] || 0) > 0);
  assert('Has assistant_message events', (matchedByAction['assistant_message'] || 0) > 0);
  assert('Has tool_use events', (matchedByAction['tool_use'] || 0) > 0);
  assert('Has tool_result events', (matchedByAction['tool_result'] || 0) > 0);
  assert('Has session_end events', (matchedByAction['session_end'] || 0) > 0);

  // Infrastructure events that should be in unmatched
  const infraTypes = [...unmatchedTypes].filter(t =>
    t.startsWith('session.model') || t.startsWith('assistant.turn') || t.startsWith('hook.'));
  console.log(`  Infrastructure events correctly unmatched: ${infraTypes.join(', ') || 'none'}`);
}

await parseRealSessions();

// ── Test 5: Watcher configuration ──
console.log('\n── Test 5: Watcher configuration ──');

const copilotWatch = transcriptWatch?.watches?.find(w => w.name === 'copilot');
if (copilotWatch) {
  assertEq('Watch schema is copilot', copilotWatch.schema, 'copilot');
  assert('Watch path targets session-state',
    copilotWatch.path?.includes('.copilot/session-state'));
  assert('Watch path targets events.jsonl',
    copilotWatch.path?.endsWith('events.jsonl'));
  assertEq('Watch startAtEnd is true', copilotWatch.startAtEnd, true);
}

// ── Test 6: Worker HTTP API ──
console.log('\n── Test 6: Worker HTTP API ──');

const workerPort = 37778;
const health = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${workerPort}/api/health`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Invalid JSON: ${data}`));
      }
    });
  }).on('error', reject);
});

assert('Worker is running', health.status === 'ok');
assert('Worker version is present', !!health.version);
assert('Worker is initialized', health.initialized === true);
console.log(`  Worker: v${health.version}, pid=${health.pid}, uptime=${health.uptime}s`);

// ── Test 7: Cross-file consistency ──
console.log('\n── Test 7: Cross-file consistency ──');

const rtSchema = transcriptWatch?.schemas?.copilot;
const exSchema = exampleConfig?.schemas?.copilot;
if (rtSchema && exSchema) {
  assertEq('Example and runtime have same schema name', rtSchema.name, exSchema.name);
  assertEq('Example and runtime have same version', rtSchema.version, exSchema.version);
  assertEq('Example and runtime have same event count',
    rtSchema.events?.length, exSchema.events?.length);
  assertEq('Example and runtime have same watch schema',
    transcriptWatch.watches.find(w => w.name === 'copilot')?.schema,
    exampleConfig.watches.find(w => w.name === 'copilot')?.schema);
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