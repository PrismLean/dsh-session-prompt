/**
 * dsh-session-prompt: session-scoped system-prompt injection for DeepSeek
 * Harness.
 *
 * One `sessionPrompt` projection carries the text; one system-prompt section
 * renders it; one tool lets a top-level agent preset the text of its own
 * subagents; one slash command is the composer's write channel.
 *
 * Design constraints this file upholds:
 *  - The text is a SYSTEM-prompt section, not a `user/message`: it is paid for
 *    every turn and cannot be compacted away. `maxChars` is an advisory
 *    threshold that reports that cost, never a gate that blocks a write.
 *  - A fork child inherits the parent's event prefix, so `apply` drops every
 *    event before `inheritedEventCount` — a forked subagent starts with an
 *    empty prompt instead of inheriting its parent's.
 *  - Permissions are enforced in code, not in the description: a subagent may
 *    never write any session's prompt, and a top-level agent may only write
 *    its own descendants, never itself.
 *
 * @module dsh-session-prompt
 */
import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';

/** Plugin display name registered with the Cordis loader. */
export const name = 'dsh-session-prompt';

/**
 * Services this plugin consumes. `sessionProjections` owns the state,
 * `systemPrompt` renders it, `tools`/`commands` are the two write channels,
 * `agents` resolves a subagent by id, `subagents` authorizes the target.
 */
export const inject = ['tools', 'sessionProjections', 'systemPrompt', 'commands', 'agents', 'subagents'];

/**
 * Schemastery configuration, validated and default-filled by the Cordis loader.
 * Every field must stay a plain resolved value: `.volatile()` turns a field into
 * a getter/write descriptor object instead of its value, which silently breaks
 * every numeric comparison downstream.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  maxChars: z.number().step(1).min(0).default(2000),
  order: z.number().step(1).min(-10000).max(10000).default(700),
});

/** System-prompt section name owned by this plugin. */
export const SECTION_NAME = 'session-prompt';
/** Session-projection key carrying the prompt text. */
export const PROJECTION_KEY = 'sessionPrompt';
/** Event type carrying one whole-text replacement. */
export const WRITE_EVENT = 'sessionPrompt/write';
/** Event type carrying the parent's pending subagent default. */
export const STAGE_EVENT = 'sessionPrompt/staged';
/** Slash command the composer overlay submits through. */
export const COMMAND_NAME = 'session-prompt';
/** Model-facing tool name. */
export const TOOL_NAME = 'session_prompt';

/**
 * Wire/state schema of the projection. `inheritedEventCount` is host-only
 * bookkeeping and never leaves the process, so it is absent from `view`.
 */
const stateSchema = zod.object({
  text: zod.string(),
  staged: zod.string().nullable(),
  inheritedEventCount: zod.number(),
});

/** The subset the browser sees. */
const viewSchema = zod.object({
  text: zod.string(),
  staged: zod.string().nullable(),
});

/** The empty state a fresh session starts from. */
export const EMPTY_STATE = Object.freeze({ text: '', staged: null, inheritedEventCount: 0 });

/**
 * Fold one session event into the projection state.
 *
 * Events at or below `inheritedEventCount` belong to the fork-inherited prefix
 * and are discarded: a forked subagent must start with an empty prompt rather
 * than silently adopting its parent's. The count is captured once in `init`,
 * which receives the exact prefix length, and never changes afterwards.
 *
 * @param state - current projection state.
 * @param event - next session event in log order.
 * @returns the next state, or `state` unchanged for unrelated events.
 */
export function reduceSessionPrompt(state, event) {
  if (event.type !== WRITE_EVENT && event.type !== STAGE_EVENT) return state;
  if (event.seq < state.inheritedEventCount) return state;
  if (event.type === WRITE_EVENT) return { ...state, text: event.data.text };
  return { ...state, staged: event.data.staged };
}

/**
 * Build the initial projection state for one session.
 * @param _header - the session header (unused; the prompt starts empty).
 * @param inheritedEventCount - exact fork-inherited prefix length.
 * @returns the fresh state carrying that prefix length.
 */
export function initSessionPrompt(_header, inheritedEventCount) {
  return { text: '', staged: null, inheritedEventCount: inheritedEventCount ?? 0 };
}

/**
 * Normalize one user- or model-supplied prompt body.
 *
 * Only the edges are trimmed: interior newlines and indentation are the
 * author's formatting and must survive verbatim. An over-budget body is
 * rejected rather than truncated, because a silently shortened instruction
 * reads as if it were complete.
 *
 * @param raw - the candidate text.
 * @returns the trimmed text, empty when the body was blank.
 */
export function normalizeText(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Describe the per-turn cost of an over-budget body.
 *
 * The budget is advisory, not a gate: the text is always stored verbatim,
 * because a silently shortened instruction reads as if it were complete. What
 * the author cannot see is the price, so the price is what gets reported.
 *
 * @param text - the normalized body.
 * @param maxChars - advisory character budget.
 * @returns a notice, or the empty string when the body is within budget.
 */
export function budgetNotice(text, maxChars) {
  if (text.length <= maxChars) return '';
  return `提示：${text.length} 字符，超过建议上限 ${maxChars}。内容已完整保存，但这段文本每轮都随系统提示词发送、不会被压缩；按中文约 1 字符 1 token 估算，每轮固定开销约 ${text.length} token。`;
}

/**
 * Compose the model-facing rendering of one tool call.
 * @param result - the structured tool value.
 * @returns one text block.
 */
function renderResult(result) {
  const where = result.target === null ? '本会话' : `子代理 ${result.target}`;
  const body = result.text.length === 0 ? '（空）' : result.text;
  const staged = result.staged === null ? '' : `\n\n待下发给新子代理：\n${result.staged || '（空）'}`;
  const notice = result.notice ? `\n\n${result.notice}` : '';
  return [{ type: 'text', text: `会话提示词 · ${where}\n\n${body}${staged}${notice}` }];
}

/** Parameter schema: every field is a permissive string; validation lives in `execute`. */
const parameters = {
  op: {
    type: 'string',
    required: true,
    description: 'set | stage | clear. `set` writes one target subagent, `stage` records the default for subagents started later, `clear` empties the target.',
  },
  target: {
    type: 'string',
    description: 'Subagent session id. Required for `set` and `clear`; must be one of YOUR OWN descendants.',
  },
  content: {
    type: 'string',
    description: 'The prompt body, verbatim. Required for `set` and `stage`.',
  },
};

/** Output schema mirroring what `render` prints. */
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', required: true },
    target: { type: 'string', required: true },
    text: { type: 'string', required: true },
    staged: { type: 'string', required: true },
    notice: { type: 'string', required: true },
  },
};

/**
 * Register the projection, the prompt section, the tool, and the command.
 * @param ctx - registrant context carrying all four registries.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const maxChars = config?.maxChars ?? 2000;
  const order = config?.order ?? 700;
  const enabled = config?.enabled ?? true;

  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema,
    init: initSessionPrompt,
    apply: reduceSessionPrompt,
    wire: {
      viewSchema,
      view: (state) => ({ text: state.text, staged: state.staged }),
    },
    stateVersion: 1,
  });

  /** Read one session's current prompt state. */
  const read = (session) => ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? EMPTY_STATE;

  if (enabled) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: SECTION_NAME,
          order,
          text: (assembly) => {
            // Diagnostics assemble without an agent; there is no session to read.
            const agent = assembly?.agent;
            if (agent === undefined) return '';
            return read(agent.session).text;
          },
        }),
      'session-prompt:section',
    );
  }

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        'Set the system prompt of one of YOUR OWN subagents, or stage a default that subagents you start later will receive. ' +
        'The text becomes a system-prompt section of that child session: it is paid for every turn and cannot be compacted away, so keep it short and durable. ' +
        'A subagent cannot call this tool at all, and an agent cannot set its own prompt — only its descendants\'. ' +
        'Use `stage` before delegating when the child must start with the instruction on its very first turn; use `set` with the child id to change a running child.',
      parameters,
      output: {
        schema: outputSchema,
        render: (_args, value) => renderResult(value),
      },
      execute(args, exec) {
        const caller = exec.agent;
        if (caller === undefined) throw new Error(`${TOOL_NAME} requires an owning agent session`);

        const depth = delegationDepthOf(caller);
        if (depth > 0) {
          throw new Error('子代理不能设置任何会话的系统提示词；只有顶层 agent 可以。');
        }

        const op = typeof args.op === 'string' ? args.op.trim() : '';
        if (op !== 'set' && op !== 'stage' && op !== 'clear') {
          throw new Error(`op 必须是 set | stage | clear，收到 ${JSON.stringify(args.op)}`);
        }

        if (op === 'stage') {
          const staged = normalizeText(args.content);
          caller.session.append(STAGE_EVENT, { staged: staged.length === 0 ? null : staged });
          return Promise.resolve({
            op,
            target: '',
            text: read(caller.session).text,
            staged,
            notice: budgetNotice(staged, maxChars),
          });
        }

        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target.length === 0) throw new Error(`op=${op} 必须提供 target（子代理的 session id）`);
        if (target === caller.session.id) {
          throw new Error('主代理不能设置自己的系统提示词；你自己的提示词由用户在输入框下方维护。');
        }

        const text = op === 'clear' ? '' : normalizeText(args.content);

        return ctx.subagents.listDescendants(caller.session.id).then((descendants) => {
          const owned = descendants.some((entry) => entry.kind === 'child' && entry.id === target);
          if (!owned) {
            throw new Error(`target ${target} 不是本会话的子代理；只能设置自己的后代。`);
          }
          const child = ctx.agents.get(target);
          if (child === undefined) {
            throw new Error(`子代理 ${target} 当前未运行（已结束或被回收），无法写入；请在它运行期间设置。`);
          }
          child.session.append(WRITE_EVENT, { text });
          return { op, target, text, staged: read(caller.session).staged ?? '', notice: budgetNotice(text, maxChars) };
        });
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '会话提示词',
        kind: 'other',
        rawInput: args,
      }),
    }),
  );

  ctx.commands.register({
    name: COMMAND_NAME,
    description: '设置当前会话的系统提示词（输入框下方按钮的写入通道）',
    recordInput: false,
    handler(invocation) {
      const text = normalizeText(invocation.rawInput);
      invocation.agent.session.append(WRITE_EVENT, { text });
      const base = text.length === 0
        ? '已清空当前会话的系统提示词。'
        : `已更新当前会话的系统提示词（${text.length} 字符）。`;
      const notice = budgetNotice(text, maxChars);
      return { kind: 'success', text: notice === '' ? base : `${base}\n${notice}` };
    },
  });

  // Stage delivery: a subagent that starts under an agent with a pending
  // `stage` receives it before its first turn. Registered per agent so the
  // scoped `subagent/start` dispatch identifies the delegating parent without
  // any reverse lookup.
  ctx.on('agent/created', ({ agent }) => {
    const arm = () => {
      agent.ctx.on('subagent/start', (info) => {
        const state = read(agent.session);
        if (state.staged === null || state.staged.length === 0) return;
        const child = ctx.agents.get(info.id);
        if (child === undefined) return;
        child.session.append(WRITE_EVENT, { text: state.staged });
      });
    };
    try {
      agent.ctx.effect(arm, 'session-prompt:stage-delivery');
    } catch {
      arm();
    }
  });
}
