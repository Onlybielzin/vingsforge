/**
 * Anthropic client port (Spec 03 §2). A minimal, structurally-typed surface the
 * engine depends on so the real `@anthropic-ai/sdk` client can be injected in
 * production and a mock in tests — no real API call is ever made under test.
 */
import type {
  Message,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * The streamed turn handle the engine consumes: it is async-iterable over raw
 * stream events, exposes `finalMessage()` for the assembled assistant turn, and
 * `abort()` for cooperative interruption (Spec 03 §4-§5). The SDK's
 * `MessageStream` satisfies this shape; tests provide a hand-rolled stub.
 */
export interface MessageStreamLike extends AsyncIterable<MessageStreamEvent> {
  finalMessage(): Promise<Message>;
  abort(): void;
}

/**
 * Request body the engine hands to the client. Modelled as `unknown`-friendly
 * because the frozen 0.68 SDK types predate `thinking:{type:'adaptive'}` and
 * `output_config.effort` (Spec 03 §2); the runtime accepts the extra fields and
 * the engine owns the construction in {@link buildRequest}.
 */
export type StreamRequest = Record<string, unknown>;

/**
 * The injected dependency. Only `messages.stream` is used: the engine always
 * streams (Spec 03 §2) and drives the agentic loop manually.
 */
export interface AnthropicLike {
  messages: {
    stream(body: StreamRequest): MessageStreamLike;
  };
}
