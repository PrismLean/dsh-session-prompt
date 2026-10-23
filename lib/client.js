/**
 * dsh-session-prompt client half: a composer control that maintains the
 * current session's system-prompt section.
 *
 * Two slots cooperate:
 *  - `conversation.input.left` holds the trigger, rendered right after the
 *    permission and plan chips (`renderSlot("conversation.input.left", {})`
 *    follows `conversation.input.permission` in the modes row).
 *  - `conversation.input.overlay` holds the editor, rendered inside the
 *    resident composer card so it floats above the input.
 *
 * The two components share one module-level open-state store keyed by session
 * id, because the slots are independent React trees.
 *
 * Writes go through the `/session-prompt` slash command — the same channel the
 * host's own permission picker uses — so the Host remains the only writer of
 * session events.
 *
 * @module dsh-session-prompt/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-prompt',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;

    /** Client services required before activation. */
    const inject = ['slots', 'sessions'];

    /** Projection key owned by the host half. */
    const PROJECTION = 'sessionPrompt';
    /** Slash command owned by the host half. */
    const COMMAND = 'session-prompt';
    /** Mirrors the host default; the host is authoritative and rejects overflow. */
    const DEFAULT_MAX_CHARS = 2000;

    /** Open state per session id; the two slots are separate React trees. */
    const openBySession = new Map();
    const listeners = new Set();
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const isOpen = (sessionId) => openBySession.get(sessionId) === true;
    const setOpen = (sessionId, open) => {
      openBySession.set(sessionId, open);
      notify();
    };

    /** Subscribe to the shared open state without tearing. */
    function useOpen(sessionId) {
      const read = React.useCallback(() => isOpen(sessionId), [sessionId]);
      if (React.useSyncExternalStore === undefined) {
        const [value, setValue] = React.useState(read);
        React.useEffect(() => {
          const off = subscribe(() => setValue(read()));
          setValue(read());
          return off;
        }, [read]);
        return value;
      }
      return React.useSyncExternalStore(subscribe, read);
    }

    /** The trigger chip: shows whether this session already carries a prompt. */
    function PromptButton({ useSession, useProjection }) {
      const sessionId = useSession((snapshot) => snapshot.sessionId);
      const value = useProjection(PROJECTION);
      const open = useOpen(sessionId);
      const active = (value?.text?.length ?? 0) > 0;
      return h(
        'button',
        {
          type: 'button',
          className: 'session-prompt-trigger',
          'aria-label': '会话提示词',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: active ? '本会话已设置系统提示词' : '为本会话添加系统提示词',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 24,
            padding: '0 6px',
            border: '1px solid transparent',
            borderRadius: 6,
            background: open ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
            opacity: active ? 1 : 0.72,
          },
          onClick: () => setOpen(sessionId, !open),
        },
        h(
          'svg',
          {
            width: 14,
            height: 14,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('path', { d: 'M2.5 3.5h11v7h-6l-3.2 2.4V10.5h-1.8z' }),
          h('path', { d: 'M5 6.5h6M5 8.2h4' }),
        ),
        active ? h('span', { style: { fontSize: 11, opacity: 0.85 } }, '提示词') : null,
      );
    }

    /** The floating editor above the composer. */
    function PromptOverlay({ useSession, useProjection, command }) {
      const sessionId = useSession((snapshot) => snapshot.sessionId);
      const value = useProjection(PROJECTION);
      const open = useOpen(sessionId);
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      // Re-seed the editor from the projection whenever it opens, so a value
      // written by the agent (or another tab) is what the user starts from.
      React.useEffect(() => {
        if (!open) return;
        setDraft(value?.text ?? '');
        setError(null);
      }, [open]);

      if (!open) return null;

      const submit = async (text) => {
        setBusy(true);
        setError(null);
        try {
          // A space separator keeps the multi-line body intact: the command
          // parser only trims the leading separator, not interior newlines.
          const result = await command(text);
          if (!result.ok) {
            setError(`${result.error.code}: ${result.error.message}`);
            return;
          }
          if (!result.value.matched) {
            setError('当前部署没有提供 /session-prompt 命令，插件可能未加载。');
            return;
          }
          setOpen(sessionId, false);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const overBudget = draft.trim().length > DEFAULT_MAX_CHARS;

      return h(
        'div',
        {
          role: 'dialog',
          'aria-label': '会话提示词',
          style: {
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 44,
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            border: '1px solid GrayText',
            borderRadius: 10,
            background: 'Canvas',
            color: 'CanvasText',
            boxShadow: '0 10px 30px rgba(0,0,0,.28)',
            fontSize: 13,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h('strong', { style: { fontSize: 13 } }, '本会话系统提示词'),
          h(
            'span',
            { style: { fontSize: 11, opacity: 0.6, color: overBudget ? 'Tomato' : undefined } },
            `${draft.trim().length} / ${DEFAULT_MAX_CHARS}`,
          ),
        ),
        h('div', { style: { fontSize: 11, opacity: 0.6, lineHeight: 1.5 } },
          '这段内容作为系统提示词注入本会话，每轮都会随请求发送，不会被压缩折叠。只写长期有效的约束。'),
        h('textarea', {
          value: draft,
          rows: 8,
          spellCheck: false,
          placeholder: '例如：本会话只讨论 X；改动前必须先给出根因分析。',
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(sessionId, false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!busy) void submit(draft);
            }
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: 120,
            padding: 8,
            border: '1px solid GrayText',
            borderRadius: 8,
            background: 'Field',
            color: 'FieldText',
            font: 'inherit',
            fontSize: 13,
            lineHeight: 1.55,
          },
        }),
        error === null
          ? null
          : h('div', { style: { fontSize: 12, color: 'Tomato', lineHeight: 1.5 } }, error),
        overBudget
          ? h('div', { style: { fontSize: 12, color: 'Tomato', lineHeight: 1.5 } },
              `超过建议上限 ${DEFAULT_MAX_CHARS} 字符（当前 ${draft.trim().length}）。仍可保存，但这段文本每轮都会随系统提示词发送、不会被压缩，按中文约 1 字符 1 token 估算，每轮固定开销约 ${draft.trim().length} token。`)
          : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => setOpen(sessionId, false),
              style: buttonStyle(false),
            },
            '取消',
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => void submit(''),
              style: buttonStyle(false),
            },
            '清空',
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => void submit(draft),
              style: buttonStyle(true),
            },
            busy ? '保存中…' : '保存',
          ),
        ),
      );
    }

    /** One compact button style for the overlay footer. */
    function buttonStyle(primary) {
      return {
        height: 28,
        padding: '0 12px',
        border: primary ? '1px solid transparent' : '1px solid GrayText',
        borderRadius: 7,
        background: primary ? 'Highlight' : 'transparent',
        color: primary ? 'HighlightText' : 'inherit',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      };
    }

    /**
     * Register both slots.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      try {
        registerAll(ctx);
      } catch (failure) {
        console.error('[session-prompt] activation failed:', failure);
        throw failure;
      }
    }

    /**
     * The real registrations, wrapped so activation failures stay visible.
     *
     * Every contribution goes through `ctx.slots.inject(name, ...)`: a child
     * slot is declared by its parent entry, so registering before the parent
     * activates throws "is not declared".
     * @param ctx - client root context.
     */
    function registerAll(ctx) {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'session-prompt',
            order: 10,
            label: '会话提示词',
          },
          PromptButton,
        ),
      );

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'session-prompt',
            order: 10,
            label: '会话提示词编辑器',
            // The slot props carry only the standard hooks; the write channel
            // is bound here so the component never reaches for a service.
            inject: (sessionId) => ({
              command: async (text) => {
                const live = ctx.sessions.binding(sessionId)?.session;
                if (live === undefined) {
                  return {
                    ok: false,
                    error: { code: 'session/not-ready', message: '这个会话还没准备好，请稍后再试。' },
                  };
                }
                return live.command(`/${COMMAND} ${text}`);
              },
            }),
          },
          PromptOverlay,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__components = { PromptButton, PromptOverlay };
    return module.exports;
  },
});
