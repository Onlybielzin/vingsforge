/**
 * In-memory mock IpcClient (Spec 06 §7 "client IPC mockável"). Drives the UI
 * with seeded projects/chats/runtimes and a scripted engine turn so the whole
 * 3-column shell renders and reacts without a real sidecar/daemon attached.
 */
import { z } from 'zod';
import type {
  Chat,
  ChatMessage,
  ChatSummary,
  EngineCommand,
  EngineEvent,
  GlobalSettings,
  ModelInfo,
  Project,
  RemoteRuntime,
} from '@vingsforge/shared';
import { KNOWN_MODELS } from '@vingsforge/shared';
import type { EngineChannel, IpcClient, Unsubscribe } from './client.js';

/** Validates an EngineCommand at the mock boundary (defensive, mirrors a real transport). */
const engineCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('engine.send'),
    chatId: z.string(),
    text: z.string(),
    // Only `modes` is inspected by the mock turn; the rest of EngineSendContext
    // (system/history/policy/...) is irrelevant to an in-memory engine.
    context: z
      .object({
        modes: z
          .object({
            autoApprove: z.boolean().optional(),
            readOnly: z.boolean().optional(),
            acceptEdits: z.boolean().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  }),
  z.object({ type: z.literal('engine.interrupt'), chatId: z.string() }),
  z.object({
    type: z.literal('tool.permission.resolve'),
    chatId: z.string(),
    callId: z.string(),
    decision: z.enum(['allow', 'deny']),
    reason: z.string().optional(),
    remember: z.boolean().optional(),
  }),
]);

const now = (): string => new Date().toISOString();

const MOCK_RUNTIMES: RemoteRuntime[] = [
  {
    id: 'vps-fra',
    label: 'fra-1 (Hetzner)',
    ssh: { host: '203.0.113.10', port: 22, user: 'deploy' },
    daemon: { installPath: '/opt/vingsforge', version: '0.1.0' },
    apiKeyLocation: 'daemon',
    status: 'online',
  },
];

const MOCK_PROJECTS: Project[] = [
  {
    id: 'p-local',
    name: 'vingsforge',
    workspace: { kind: 'local', path: '/home/vings/dev/vingsforge' },
    runtimeId: 'local',
    defaultModel: 'claude-opus-4-8',
    createdAt: now(),
    lastOpenedAt: now(),
  },
  {
    id: 'p-remote',
    name: 'shop-api',
    workspace: { kind: 'remote', runtimeId: 'vps-fra', path: '/srv/shop' },
    runtimeId: 'vps-fra',
    defaultModel: 'claude-sonnet-4-6',
    createdAt: now(),
  },
];

const MOCK_CHATS: Record<string, ChatSummary[]> = {
  'p-local': [
    {
      id: 'c-1',
      projectId: 'p-local',
      title: 'Refactor input bar',
      updatedAt: now(),
      archived: false,
      lastMessagePreview: 'Splitting the textarea into its own component...',
    },
    {
      id: 'c-2',
      projectId: 'p-local',
      title: 'Fix token footer',
      updatedAt: now(),
      archived: false,
    },
  ],
  'p-remote': [],
};

const MOCK_HISTORY: Record<string, ChatMessage[]> = {
  'c-1': [
    {
      id: 'm-1',
      chatId: 'c-1',
      role: 'user',
      blocks: [{ kind: 'text', text: 'Read the input bar and suggest a refactor.' }],
      createdAt: now(),
    },
    {
      id: 'm-2',
      chatId: 'c-1',
      role: 'assistant',
      model: 'claude-opus-4-8',
      blocks: [
        { kind: 'thinking', text: 'The input bar mixes model selection and send logic.' },
        { kind: 'text', text: 'I will read the file first.' },
        {
          kind: 'tool_use',
          callId: 't-1',
          tool: 'read_file',
          input: { path: 'src/components/InputBar.tsx' },
        },
        {
          kind: 'tool_result',
          callId: 't-1',
          isError: false,
          output: 'export function InputBar() { /* ... */ }',
        },
        { kind: 'text', text: 'It mixes concerns. I suggest extracting the model selector.' },
      ],
      usage: { inputTokens: 1820, outputTokens: 410, estimatedCostUsd: 0.014 },
      createdAt: now(),
    },
  ],
  'c-2': [],
};

const MOCK_MODELS: ModelInfo[] = KNOWN_MODELS.map((id) => ({
  id,
  displayName: id.replace(/^claude-/, '').replace(/-/g, ' '),
  supportsThinking: id.includes('opus') || id.includes('sonnet'),
}));

let settings: GlobalSettings = {
  authMode: 'plan',
  apiKeyPresent: true,
  defaultModel: 'claude-opus-4-8',
  defaultEffort: 'high',
  showThinking: true,
  permissionDefaults: { bash: 'ask', write_file: 'ask', edit_file: 'ask' },
  theme: 'dark',
  showCost: true,
};

/** A mock engine that scripts a streaming turn with a permission gate. */
class MockEngine implements EngineChannel {
  private listeners = new Set<(event: EngineEvent) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  onEvent(listener: (event: EngineEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(command: EngineCommand): Promise<void> {
    const parsed = engineCommandSchema.parse(command);
    if (parsed.type === 'engine.send') {
      this.runTurn(parsed.chatId, parsed.context?.modes);
    } else if (parsed.type === 'engine.interrupt') {
      this.clearTimers();
      this.emit({
        type: 'turn.end',
        chatId: parsed.chatId,
        stopReason: 'interrupted',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    } else if (parsed.type === 'tool.permission.resolve') {
      if (parsed.decision === 'deny') {
        this.emit({
          type: 'tool.result',
          chatId: parsed.chatId,
          callId: parsed.callId,
          output: parsed.reason ?? 'Denied by user.',
          isError: true,
        });
      } else {
        this.emit({
          type: 'tool.result',
          chatId: parsed.chatId,
          callId: parsed.callId,
          output: '$ ls\nREADME.md  package.json  src',
          isError: false,
        });
      }
      this.schedule(() => {
        this.emit({ type: 'message.delta', chatId: parsed.chatId, text: 'Done.' });
        this.emit({
          type: 'turn.end',
          chatId: parsed.chatId,
          stopReason: 'end_turn',
          usage: { inputTokens: 2100, outputTokens: 90, estimatedCostUsd: 0.008 },
        });
      }, 400);
    }
  }

  private runTurn(
    chatId: string,
    modes: { autoApprove?: boolean | undefined; readOnly?: boolean | undefined; acceptEdits?: boolean | undefined } = {},
  ): void {
    const callId = `call-${Date.now()}`;
    this.schedule(() => this.emit({ type: 'thinking.delta', chatId, text: 'Planning the change. ' }), 100);
    this.schedule(() => this.emit({ type: 'message.delta', chatId, text: 'Let me inspect the workspace. ' }), 300);
    this.schedule(
      () => this.emit({ type: 'tool.start', chatId, tool: 'bash', input: { command: 'ls' }, callId }),
      600,
    );
    // Honor the quick modes exactly as the real policy does (Spec 04 §3.2):
    // read-only denies write/edit/bash, auto-approve runs without asking, and
    // only the remaining case actually gates with a permission prompt.
    if (modes.readOnly) {
      this.schedule(() => {
        this.emit({
          type: 'tool.result',
          chatId,
          callId,
          output: "read-only mode: 'bash' is disabled",
          isError: true,
        });
        this.emit({
          type: 'turn.end',
          chatId,
          stopReason: 'end_turn',
          usage: { inputTokens: 2000, outputTokens: 40 },
        });
      }, 800);
      return;
    }
    if (modes.autoApprove) {
      this.schedule(() => {
        this.emit({
          type: 'tool.result',
          chatId,
          callId,
          output: '$ ls\nREADME.md  package.json  src',
          isError: false,
        });
        this.emit({ type: 'message.delta', chatId, text: 'Done.' });
        this.emit({
          type: 'turn.end',
          chatId,
          stopReason: 'end_turn',
          usage: { inputTokens: 2100, outputTokens: 90, estimatedCostUsd: 0.008 },
        });
      }, 800);
      return;
    }
    this.schedule(
      () => this.emit({ type: 'tool.permission', chatId, callId, tool: 'bash', input: { command: 'ls' } }),
      800,
    );
  }

  private emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** Builds a fully in-memory {@link IpcClient} for development and demos. */
export function createMockIpcClient(): IpcClient {
  const projects = structuredClone(MOCK_PROJECTS);
  const chats = structuredClone(MOCK_CHATS);
  const history = structuredClone(MOCK_HISTORY);
  const runtimes = structuredClone(MOCK_RUNTIMES);
  const engine = new MockEngine();
  let chatSeq = 100;

  return {
    engine,
    projects: {
      async list() {
        return structuredClone(projects);
      },
      async create(input) {
        const project: Project = {
          id: `p-${Date.now()}`,
          name: input.name ?? 'new project',
          workspace: input.workspace,
          runtimeId: input.runtimeId ?? 'local',
          createdAt: now(),
        };
        projects.push(project);
        chats[project.id] = [];
        return structuredClone(project);
      },
      async open(id) {
        const project = projects.find((p) => p.id === id);
        if (!project) throw new Error(`Unknown project ${id}`);
        return { project: structuredClone(project), chats: structuredClone(chats[id] ?? []) };
      },
      async rename(id, name) {
        const p = projects.find((x) => x.id === id);
        if (p) p.name = name;
      },
      async updateConfig(id, patch) {
        const p = projects.find((x) => x.id === id);
        if (!p) throw new Error(`Unknown project ${id}`);
        Object.assign(p, patch);
        return structuredClone(p);
      },
      async remove(id) {
        const i = projects.findIndex((p) => p.id === id);
        if (i >= 0) projects.splice(i, 1);
      },
      async worktrees(projectId) {
        const project = projects.find((p) => p.id === projectId);
        // Remote workspaces have no local repo to inspect.
        if (!project || project.workspace.kind !== 'local') return [];
        const root = project.workspace.path;
        return [
          { path: root, branch: 'main', head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', isMain: true },
          {
            path: `${root}-feature`,
            branch: 'feature/worktrees',
            head: 'f0e9d8c7b6a5948372615f0e9d8c7b6a5948372',
            isMain: false,
          },
          {
            path: `${root}-hotfix`,
            head: 'deadbeefcafebabefeedface0123456789abcdef',
            isMain: false,
            isDetached: true,
            isLocked: true,
          },
        ];
      },
    },
    chats: {
      async list(projectId) {
        return structuredClone(chats[projectId] ?? []);
      },
      async create(projectId, opts) {
        const id = `c-${(chatSeq += 1)}`;
        const chat: Chat = {
          id,
          projectId,
          title: 'new chat',
          ...(opts?.model ? { modelOverride: opts.model } : {}),
          ...(opts?.runtimeId ? { runtimeOverride: opts.runtimeId } : {}),
          createdAt: now(),
          updatedAt: now(),
          archived: false,
        };
        (chats[projectId] ??= []).unshift({
          id,
          projectId,
          title: chat.title,
          updatedAt: chat.updatedAt,
          archived: false,
        });
        history[id] = [];
        return chat;
      },
      async history(chatId) {
        return structuredClone(history[chatId] ?? []);
      },
      async send(chatId, text, modes) {
        (history[chatId] ??= []).push({
          id: `m-${Date.now()}`,
          chatId,
          role: 'user',
          blocks: [{ kind: 'text', text }],
          createdAt: now(),
        });
        // Forward the quick modes onto the turn context so the engine gates the
        // turn (read-only / auto-approve) instead of them being UI-only state.
        // The mock engine only inspects `modes`; the real host fills the rest of
        // EngineSendContext (system/history/policy) from persisted state.
        await engine.send({
          type: 'engine.send',
          chatId,
          text,
          ...(modes
            ? { context: { system: '', history: history[chatId] ?? [], modes } }
            : {}),
        });
      },
      async interrupt(chatId) {
        await engine.send({ type: 'engine.interrupt', chatId });
      },
      async rename(chatId, title) {
        for (const list of Object.values(chats)) {
          const c = list.find((x) => x.id === chatId);
          if (c) c.title = title;
        }
      },
      async archive(chatId) {
        for (const list of Object.values(chats)) {
          const c = list.find((x) => x.id === chatId);
          if (c) c.archived = true;
        }
      },
      async delete(chatId) {
        for (const list of Object.values(chats)) {
          const i = list.findIndex((x) => x.id === chatId);
          if (i >= 0) list.splice(i, 1);
        }
      },
    },
    runtimes: {
      async list() {
        return structuredClone(runtimes);
      },
      async add() {
        throw new Error('not implemented in mock');
      },
      async connect(id) {
        const r = runtimes.find((x) => x.id === id);
        if (r) r.status = 'online';
      },
      async disconnect(id) {
        const r = runtimes.find((x) => x.id === id);
        if (r) r.status = 'offline';
      },
      async installDaemon() {
        /* no-op */
      },
      async fsList(_id, path) {
        return [
          { name: 'src', path: `${path}/src`, kind: 'dir' },
          { name: 'package.json', path: `${path}/package.json`, kind: 'file', size: 812 },
          { name: 'README.md', path: `${path}/README.md`, kind: 'file', size: 1240 },
        ];
      },
      async remove(id) {
        const i = runtimes.findIndex((r) => r.id === id);
        if (i >= 0) runtimes.splice(i, 1);
      },
    },
    settings: {
      async get() {
        return structuredClone(settings);
      },
      async update(patch) {
        settings = { ...settings, ...patch };
        return structuredClone(settings);
      },
      async setApiKey() {
        settings = { ...settings, apiKeyPresent: true };
      },
      async clearApiKey() {
        settings = { ...settings, apiKeyPresent: false };
      },
      async testApiKey() {
        return { ok: settings.apiKeyPresent };
      },
      async models() {
        return structuredClone(MOCK_MODELS);
      },
    },
  };
}
