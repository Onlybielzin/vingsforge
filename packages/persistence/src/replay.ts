/**
 * Replay reconstruction for continuing a chat against the API (Spec 08 §4).
 *
 * Two model-aware rules the raw `messages.list()` output does NOT apply on its own:
 *
 *  1. `thinking` blocks are only valid to replay against the same model that
 *     produced them. When the chat's current model differs from the model that
 *     generated a past assistant turn, that turn's `thinking` blocks must be
 *     dropped (other models reject foreign extended-thinking turns).
 *  2. Extended-thinking replay requires the `signature` the API issued. A
 *     `thinking` block without a signature cannot be replayed and is dropped.
 *
 * Use `buildReplayMessages` to assemble the history sent to the API; use
 * `assertAppendableBlocks` to reject persisting un-replayable `thinking` blocks.
 */
import type { Block, ChatMessage, ModelId } from '@vingsforge/shared';
import type { DbStore } from './store.js';

/** True when a thinking block carries the signature required for replay. */
function thinkingHasSignature(
  block: Block,
): block is Extract<Block, { kind: 'thinking' }> & { signature: string } {
  return (
    block.kind === 'thinking' &&
    typeof block.signature === 'string' &&
    block.signature.length > 0
  );
}

/**
 * Apply the Spec 08 §4 thinking rules to a single message given the chat's
 * current model. Returns a (possibly block-filtered) copy; messages whose
 * blocks all get dropped are returned with an empty `blocks` array and should
 * be skipped by the caller.
 */
function reconcileMessage(
  message: ChatMessage,
  currentModel: ModelId | undefined,
): ChatMessage {
  const hasThinking = message.blocks.some((b) => b.kind === 'thinking');
  if (!hasThinking) return message;

  // Keep thinking only when the producing model matches the chat's current
  // model AND the signature is present. If we don't know the producing model,
  // we cannot prove it matches, so we drop thinking to stay replay-safe.
  const sameModel =
    currentModel !== undefined && message.model === currentModel;

  const blocks = message.blocks.filter((block) => {
    if (block.kind !== 'thinking') return true;
    return sameModel && thinkingHasSignature(block);
  });

  return { ...message, blocks };
}

/**
 * Build the ordered message history to send to the API for a chat, applying the
 * model-aware thinking rules (Spec 08 §4). `currentModel` is the chat's
 * effective model (chat.modelOverride ?? project.defaultModel). Messages left
 * with no blocks after reconciliation are omitted.
 */
export function buildReplayMessages(
  store: DbStore,
  chatId: string,
  currentModel: ModelId | undefined,
): ChatMessage[] {
  return store.messages
    .list(chatId)
    .map((m) => reconcileMessage(m, currentModel))
    .filter((m) => m.blocks.length > 0);
}

/**
 * Guard for the append path: a persisted `thinking` block must carry a
 * signature, otherwise it can never be replayed for extended thinking (Spec 08
 * §4). Throws on the first offending block.
 */
export function assertAppendableBlocks(blocks: Block[]): void {
  for (const block of blocks) {
    if (block.kind === 'thinking' && !thinkingHasSignature(block)) {
      throw new Error(
        'Cannot persist a thinking block without a signature: ' +
          'extended-thinking replay requires the signature (Spec 08 §4).',
      );
    }
  }
}
