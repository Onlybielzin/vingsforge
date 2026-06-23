/**
 * Claude CLI runner tests. The `claude` binary is NEVER spawned — we inject a
 * fake `spawn` that returns a scriptable child (stdout/stderr/stdin streams +
 * close/error events). We assert the spawned argv/env, the NDJSON → EngineEvent
 * mapping, persistence calls, per-chat `--resume` continuity, abort handling,
 * and the missing-binary / error paths.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, EngineEvent } from '@vingsforge/shared';
import type { EngineTurnInput } from '../chats/store.js';
import {
  makeClaudeCliRunner,
  mapPermissionMode,
  type ClaudeAuth,
} from './claude-cli-runner.js';

/** A fake child process the runner reads NDJSON from and writes stdin to. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinChunks: string[] = [];
  readonly stdin: Writable;
  killed: string | undefined;

  constructor() {
    super();
    const chunks = this.stdinChunks;
    this.stdin = new Writable({
      write(chunk, _enc, cb): void {
        chunks.push(chunk.toString());
        cb();
      },
    });
  }

  /** Push NDJSON lines onto stdout. */
  emitLines(lines: object[]): void {
    for (const l of lines) this.stdout.write(`${JSON.stringify(l)}\n`);
  }

  /** Finish the stream and exit with `code`. */
  exit(code: number): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }

  kill(signal: string): boolean {
    this.killed = signal;
    return true;
  }
}

interface Harness {
  child: FakeChild;
  spawnArgs: { bin: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } };
  events: EngineEvent[];
  persistedAssistant: ChatMessage[];
  persistedToolResults: ChatMessage[];
}

/** Flush pending microtasks so the runner has attached its stdout/close handlers. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function makeInput(over: Partial<EngineTurnInput> = {}): EngineTurnInput {
  return {
    chatId: 'chat-1',
    system: 'sys',
    history: [],
    userText: 'hello world',
    controller: new AbortController(),
    persistAssistant: () => undefined,
    persistToolResults: () => undefined,
    ...over,
  };
}

function setup(
  auth: ClaudeAuth = { authMode: 'plan' },
  root = '/work/root',
): {
  run: ReturnType<typeof makeClaudeCliRunner>;
  h: Harness;
} {
  const child = new FakeChild();
  const h: Harness = {
    child,
    spawnArgs: { bin: '', args: [], opts: {} },
    events: [],
    persistedAssistant: [],
    persistedToolResults: [],
  };
  const fakeSpawn = vi.fn((bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    h.spawnArgs = { bin, args, opts };
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  });
  const run = makeClaudeCliRunner({
    resolveWorkspaceRoot: () => root,
    resolveAuth: () => auth,
    claudeBin: '/fake/claude',
    spawn: fakeSpawn as unknown as typeof import('node:child_process').spawn,
  });
  return { run, h };
}

function withPersist(h: Harness, over: Partial<EngineTurnInput> = {}): EngineTurnInput {
  return makeInput({
    persistAssistant: (_id, m) => h.persistedAssistant.push(m),
    persistToolResults: (_id, m) => h.persistedToolResults.push(m),
    ...over,
  });
}

describe('makeClaudeCliRunner', () => {
  it('spawns claude with stream-json args, feeds userText via stdin, maps a text turn', async () => {
    const { run, h } = setup();
    const input = withPersist(h, { userText: 'do the thing', model: 'claude-opus-4-8' });
    const p = run(input, (e) => h.events.push(e));
    await tick();

    // Drive the scripted stream once the child exists.
    h.child.emitLines([
      { type: 'system', subtype: 'init', session_id: 'sess-abc', apiKeySource: 'none' },
      {
        type: 'assistant',
        message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
      },
    ]);
    h.child.exit(0);
    const result = await p;

    // argv
    expect(h.spawnArgs.bin).toBe('/fake/claude');
    expect(h.spawnArgs.args).toContain('--output-format');
    expect(h.spawnArgs.args).toContain('stream-json');
    expect(h.spawnArgs.args).toEqual(
      expect.arrayContaining(['-p', '--input-format', 'text', '--model', 'claude-opus-4-8']),
    );
    expect(h.spawnArgs.args).toEqual(expect.arrayContaining(['--add-dir', '/work/root']));
    expect(h.spawnArgs.args).not.toContain('--resume');
    expect(h.spawnArgs.opts.cwd).toBe('/work/root');

    // stdin carried the prompt (NOT argv)
    expect(h.child.stdinChunks.join('')).toBe('do the thing');
    expect(h.spawnArgs.args).not.toContain('do the thing');

    // plan auth strips the key from the child env
    expect(h.spawnArgs.opts.env?.ANTHROPIC_API_KEY).toBeUndefined();

    // events
    expect(h.events).toEqual([
      { type: 'message.delta', chatId: 'chat-1', text: 'Hi there' },
      {
        type: 'turn.end',
        chatId: 'chat-1',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 },
      },
    ]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);

    // persisted assistant turn
    expect(h.persistedAssistant).toHaveLength(1);
    expect(h.persistedAssistant[0]?.blocks).toEqual([{ kind: 'text', text: 'Hi there' }]);
  });

  it('maps thinking + tool_use + tool_result and persists paired turns', async () => {
    const { run, h } = setup();
    const p = run(withPersist(h), (e) => h.events.push(e));
    await tick();
    h.child.emitLines([
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'thinking', thinking: 'pondering', signature: 'sig' },
            { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.txt' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file body', is_error: false }],
        },
      },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    h.child.exit(0);
    await p;

    expect(h.events).toEqual([
      { type: 'thinking.delta', chatId: 'chat-1', text: 'pondering' },
      { type: 'tool.start', chatId: 'chat-1', tool: 'read_file', input: { path: 'a.txt' }, callId: 'tu-1' },
      { type: 'tool.result', chatId: 'chat-1', callId: 'tu-1', output: 'file body', isError: false },
      expect.objectContaining({ type: 'turn.end' }),
    ]);
    expect(h.persistedAssistant[0]?.blocks).toEqual([
      { kind: 'thinking', text: 'pondering', signature: 'sig' },
      { kind: 'tool_use', callId: 'tu-1', tool: 'read_file', input: { path: 'a.txt' } },
    ]);
    expect(h.persistedToolResults[0]?.blocks).toEqual([
      { kind: 'tool_result', callId: 'tu-1', output: 'file body', isError: false },
    ]);
  });

  it('passes --resume with the captured session_id on the second turn of a chat', async () => {
    const children: FakeChild[] = [];
    const seqArgs: string[][] = [];
    const runSeq = makeClaudeCliRunner({
      resolveWorkspaceRoot: () => '/r',
      resolveAuth: () => ({ authMode: 'plan' }),
      claudeBin: '/fake/claude',
      spawn: ((_bin: string, args: string[]) => {
        seqArgs.push(args);
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as unknown as typeof import('node:child_process').spawn,
    });

    const r1 = runSeq(makeInput(), () => undefined);
    await tick();
    children[0]!.emitLines([
      { type: 'system', subtype: 'init', session_id: 'SID-1' },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    children[0]!.exit(0);
    await r1;

    const r2 = runSeq(makeInput(), () => undefined);
    await tick();
    children[1]!.emitLines([
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    children[1]!.exit(0);
    await r2;

    expect(seqArgs[0]).not.toContain('--resume');
    expect(seqArgs[1]).toEqual(expect.arrayContaining(['--resume', 'SID-1']));
  });

  it('injects ANTHROPIC_API_KEY for apiKey auth and strips it for plan', async () => {
    const { run, h } = setup({ authMode: 'apiKey', apiKey: 'sk-secret' });
    const p = run(withPersist(h), () => undefined);
    await tick();
    h.child.emitLines([
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    h.child.exit(0);
    await p;
    expect(h.spawnArgs.opts.env?.ANTHROPIC_API_KEY).toBe('sk-secret');
  });

  it('aborts: kills the child and ends with stopReason interrupted', async () => {
    const { run, h } = setup();
    const controller = new AbortController();
    const p = run(withPersist(h, { controller }), (e) => h.events.push(e));
    await tick();
    controller.abort();
    // The child is killed; emulate its close.
    h.child.exit(143);
    const result = await p;
    expect(h.child.killed).toBe('SIGTERM');
    expect(result.stopReason).toBe('interrupted');
    expect(h.events.at(-1)).toEqual(
      expect.objectContaining({ type: 'turn.end', stopReason: 'interrupted' }),
    );
  });

  it('result.is_error emits an error event and ends the turn', async () => {
    const { run, h } = setup();
    const p = run(withPersist(h), (e) => h.events.push(e));
    await tick();
    h.child.emitLines([
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', usage: { input_tokens: 0, output_tokens: 0 } },
    ]);
    h.child.exit(1);
    const result = await p;
    expect(h.events).toEqual(
      expect.arrayContaining([{ type: 'error', chatId: 'chat-1', message: 'boom' }]),
    );
    expect(result.stopReason).toBe('end_turn');
  });

  it('exits without a result: emits an error, never crashes', async () => {
    const { run, h } = setup();
    const p = run(withPersist(h), (e) => h.events.push(e));
    await tick();
    h.child.stderr.write('some stderr detail');
    h.child.exit(2);
    const result = await p;
    expect(h.events.some((e) => e.type === 'error')).toBe(true);
    expect(result.stopReason).toBe('end_turn');
  });

  it('missing binary (via CLAUDE_BIN_ENV): emits an error and returns without spawning', async () => {
    const prev = process.env.VINGSFORGE_CLAUDE_BIN;
    process.env.VINGSFORGE_CLAUDE_BIN = '/does/not/exist/claude';
    try {
      const spawnSpy = vi.fn();
      const run = makeClaudeCliRunner({
        resolveWorkspaceRoot: () => '/r',
        resolveAuth: () => ({ authMode: 'plan' }),
        // no explicit claudeBin: forces the env/PATH resolution path
        spawn: spawnSpy as unknown as typeof import('node:child_process').spawn,
      });
      const events: EngineEvent[] = [];
      const result = await run(makeInput(), (e) => events.push(e));
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(events[0]?.type).toBe('error');
      expect(result.stopReason).toBe('end_turn');
    } finally {
      if (prev === undefined) delete process.env.VINGSFORGE_CLAUDE_BIN;
      else process.env.VINGSFORGE_CLAUDE_BIN = prev;
    }
  });
});

describe('mapPermissionMode', () => {
  it('maps quick modes to CLI permission modes', () => {
    expect(mapPermissionMode({ readOnly: true })).toBe('plan');
    expect(mapPermissionMode({ autoApprove: true })).toBe('bypassPermissions');
    expect(mapPermissionMode({ acceptEdits: true })).toBe('acceptEdits');
    expect(mapPermissionMode(undefined)).toBe('acceptEdits');
    expect(mapPermissionMode({})).toBe('acceptEdits');
  });
});
