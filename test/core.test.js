/**
 * Unit tests for the pure halves of dsh-session-prompt plus a mocked-context
 * integration pass over the registered tool's permission matrix.
 *
 * The host is faked rather than booted: these tests pin the decisions this
 * plugin owns (fork filtering, advisory budgeting, who may write whose prompt),
 * not the Cordis runtime underneath them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_NAME,
  EMPTY_STATE,
  PROJECTION_KEY,
  STAGE_EVENT,
  TOOL_NAME,
  WRITE_EVENT,
  apply,
  budgetNotice,
  initSessionPrompt,
  normalizeText,
  reduceSessionPrompt,
  recordWriter,
} from '../lib/index.js';

// Route the real plugin-record channel back through the fake sessions' own
// `append`, so these tests observe the same `{type, data}` pairs without a
// live Session. Production uses `appendPluginRecord`, which needs one.
recordWriter.append = (session, type, data) => {
  session.append(type, data);
};

/** Build one session event with the fields the reducer reads. */
const event = (type, seq, data) => ({ type, seq, data });

test('initSessionPrompt starts empty and records the fork prefix length', () => {
  assert.deepEqual(initSessionPrompt({}, 0), { text: '', staged: null, inheritedEventCount: 0 });
  assert.deepEqual(initSessionPrompt({}, 42), { text: '', staged: null, inheritedEventCount: 42 });
  assert.deepEqual(initSessionPrompt({}, undefined), EMPTY_STATE);
});

test('reduceSessionPrompt is last-write-wins over whole-text snapshots', () => {
  let state = initSessionPrompt({}, 0);
  state = reduceSessionPrompt(state, event(WRITE_EVENT, 1, { text: 'first' }));
  assert.equal(state.text, 'first');
  state = reduceSessionPrompt(state, event(WRITE_EVENT, 2, { text: 'second' }));
  assert.equal(state.text, 'second');
  state = reduceSessionPrompt(state, event(WRITE_EVENT, 3, { text: '' }));
  assert.equal(state.text, '');
});

test('reduceSessionPrompt ignores unrelated events', () => {
  const state = initSessionPrompt({}, 0);
  assert.equal(reduceSessionPrompt(state, event('todo/write', 1, { todos: [] })), state);
  assert.equal(reduceSessionPrompt(state, event('turn/start', 2, {})), state);
});

test('reduceSessionPrompt drops the fork-inherited prefix', () => {
  // A forked child replays its parent's log from seq 0; every event below the
  // inherited count belongs to the parent and must not become the child's prompt.
  const forked = initSessionPrompt({}, 5);
  const inherited = reduceSessionPrompt(forked, event(WRITE_EVENT, 3, { text: 'parent prompt' }));
  assert.equal(inherited.text, '', 'inherited parent write must be discarded');

  // The child's own write lands at or after the cut and is kept.
  const own = reduceSessionPrompt(inherited, event(WRITE_EVENT, 5, { text: 'child prompt' }));
  assert.equal(own.text, 'child prompt');
});

test('reduceSessionPrompt tracks the staged default independently of the text', () => {
  let state = initSessionPrompt({}, 0);
  state = reduceSessionPrompt(state, event(STAGE_EVENT, 1, { staged: 'for subagents' }));
  assert.equal(state.staged, 'for subagents');
  assert.equal(state.text, '');
  state = reduceSessionPrompt(state, event(STAGE_EVENT, 2, { staged: null }));
  assert.equal(state.staged, null);
});

test('normalizeText trims only the edges and keeps interior formatting', () => {
  assert.equal(normalizeText('  hello  ', 100), 'hello');
  assert.equal(normalizeText('\n\n  a\n  b\n\n', 100), 'a\n  b');
  assert.equal(normalizeText('   ', 100), '');
  assert.equal(normalizeText(undefined, 100), '');
});

test('normalizeText only trims edges and never truncates a long body', () => {
  assert.equal(normalizeText('  x  '), 'x');
  assert.equal(normalizeText('a\n  b\n'), 'a\n  b', 'interior formatting survives');
  assert.equal(normalizeText(42), '', 'non-strings normalize to empty');
  assert.equal(normalizeText('x'.repeat(50000)).length, 50000, 'length is never the normalizer\'s business');
});

/**
 * Minimal Cordis stand-in: records every registration the plugin makes and
 * exposes just enough surface for the tool and command handlers to run.
 */
function fakeContext() {
  const registered = { projection: null, section: null, tool: null, command: null, created: null };
  const effects = [];
  const listeners = new Map();

  const ctx = {
    sessionProjections: {
      register(definition) {
        registered.projection = definition;
        return () => {};
      },
      stateOf(session, key) {
        assert.equal(key, PROJECTION_KEY);
        return session.__state;
      },
    },
    systemPrompt: {
      section(definition) {
        registered.section = definition;
        return () => {};
      },
    },
    tools: {
      register(definition) {
        registered.tool = definition;
        return () => {};
      },
    },
    commands: {
      register(definition) {
        registered.command = definition;
        return () => {};
      },
    },
    agents: {
      get(id) {
        return ctx.__agents?.get(id);
      },
    },
    subagents: {
      async listDescendants() {
        return ctx.__descendants ?? [];
      },
    },
    effect(factory) {
      // Cordis runs an effect factory immediately and owns its disposer; the
      // fake must do the same or nothing registered through `ctx.effect` exists.
      effects.push(factory());
      return () => {};
    },
    on(name, listener) {
      listeners.set(name, listener);
      return () => {};
    },
    __agents: new Map(),
    __descendants: [],
  };
  return { ctx, registered, effects, listeners };
}

/** One fake agent whose depth is driven by its session header. */
function fakeAgent(id, delegationDepth = 0) {
  const appended = [];
  return {
    id,
    session: {
      id,
      header: { id, delegationDepth },
      append(type, data) {
        appended.push({ type, data });
        return appended.length;
      },
    },
    options: {},
    appended,
  };
}

test('apply registers exactly one projection, section, tool, and command', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 100, order: 700 });

  assert.equal(registered.projection.key, PROJECTION_KEY);
  assert.equal(registered.projection.stateVersion, 1);
  assert.equal(registered.section.name, 'session-prompt');
  assert.equal(registered.section.order, 700);
  assert.equal(registered.tool.name, TOOL_NAME);
  assert.equal(registered.command.name, COMMAND_NAME);
  assert.equal(registered.command.recordInput, false, 'the domain event owns the payload');
});

test('the section reads the current session projection and stays blank without an agent', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 100, order: 700 });

  assert.equal(registered.section.text({}), '', 'diagnostics assemble without an agent');
  const agent = fakeAgent('s1');
  agent.session.__state = { text: 'session rule', staged: null, inheritedEventCount: 0 };
  assert.equal(registered.section.text({ agent }), 'session rule');
});

test('the section is not registered when the plugin is disabled', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: false, maxChars: 100, order: 700 });
  assert.equal(registered.section, null);
  assert.notEqual(registered.tool, null, 'disabling injection keeps the write channels inspectable');
});

test('a subagent may not write any session prompt', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 100, order: 700 });

  const child = fakeAgent('child', 1);
  await assert.rejects(
    () => registered.tool.execute({ op: 'stage', content: 'x' }, { agent: child }),
    /子代理不能设置任何会话的系统提示词/,
  );
});

test('an agent may not write its own prompt', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 100, order: 700 });

  const root = fakeAgent('root', 0);
  await assert.rejects(
    () => registered.tool.execute({ op: 'set', target: 'root', content: 'x' }, { agent: root }),
    /主代理不能设置自己的系统提示词/,
  );
});

test('an agent may only write a descendant that is currently running', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 100, order: 700 });

  const root = fakeAgent('root', 0);

  // Not a descendant at all.
  ctx.__descendants = [{ kind: 'child', id: 'stranger' }];
  await assert.rejects(
    () => registered.tool.execute({ op: 'set', target: 'other', content: 'x' }, { agent: root }),
    /不是本会话的子代理/,
  );

  // A descendant that is no longer live.
  await assert.rejects(
    () => registered.tool.execute({ op: 'set', target: 'stranger', content: 'x' }, { agent: root }),
    /当前未运行/,
  );

  // A live descendant accepts the write, which lands on the CHILD's log.
  const child = fakeAgent('stranger', 1);
  ctx.__agents.set('stranger', child);
  const value = await registered.tool.execute({ op: 'set', target: 'stranger', content: ' do x ' }, { agent: root });
  assert.deepEqual(value, { op: 'set', target: 'stranger', text: 'do x', staged: '', notice: '' });
  assert.deepEqual(child.appended, [{ type: WRITE_EVENT, data: { text: 'do x' } }]);
  assert.deepEqual(root.appended, [], 'the parent log stays untouched');
});

test('stage records the default on the caller and clear empties a child', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 100, order: 700 });

  const root = fakeAgent('root', 0);
  const staged = await registered.tool.execute({ op: 'stage', content: 'default' }, { agent: root });
  assert.equal(staged.staged, 'default');
  assert.deepEqual(root.appended, [{ type: STAGE_EVENT, data: { staged: 'default' } }]);

  const child = fakeAgent('kid', 1);
  ctx.__descendants = [{ kind: 'child', id: 'kid' }];
  ctx.__agents.set('kid', child);
  await registered.tool.execute({ op: 'clear', target: 'kid' }, { agent: root });
  assert.deepEqual(child.appended, [{ type: WRITE_EVENT, data: { text: '' } }]);
});

test('the command writes the current session and reports overflow as advice', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 10, order: 700 });

  const agent = fakeAgent('s1', 0);
  const result = registered.command.handler({ agent, rawInput: '  be terse  ' });
  assert.equal(result.kind, 'success');
  assert.deepEqual(agent.appended, [{ type: WRITE_EVENT, data: { text: 'be terse' } }]);
  assert.ok(!result.text.includes('超过建议上限'), 'within budget stays silent');

  const over = registered.command.handler({ agent, rawInput: 'x'.repeat(11) });
  assert.equal(over.kind, 'success', 'overflow is advice, never a failure');
  assert.deepEqual(agent.appended.at(-1), {
    type: WRITE_EVENT,
    data: { text: 'x'.repeat(11) },
  }, 'the over-budget body is stored verbatim, not truncated');
  assert.match(over.text, /超过建议上限 10/);
});

test('budgetNotice is silent within budget and prices the overflow otherwise', () => {
  assert.equal(budgetNotice('12345', 5), '', 'exactly at budget is still fine');
  const notice = budgetNotice('123456', 5);
  assert.match(notice, /6 字符/);
  assert.match(notice, /建议上限 5/);
  assert.match(notice, /6 token/, 'the notice states the per-turn price');
});

test('the tool reports the same notice instead of refusing the write', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: true, maxChars: 10, order: 700 });

  const root = fakeAgent('root', 0);
  const child = fakeAgent('kid', 1);
  ctx.__descendants = [{ kind: 'child', id: 'kid' }];
  ctx.__agents.set('kid', child);

  const value = await registered.tool.execute(
    { op: 'set', target: 'kid', content: 'y'.repeat(12) },
    { agent: root },
  );
  assert.deepEqual(child.appended, [{ type: WRITE_EVENT, data: { text: 'y'.repeat(12) } }]);
  assert.match(value.notice, /超过建议上限 10/);
  assert.match(value.text, /^y{12}$/, 'the stored text is complete');
});
