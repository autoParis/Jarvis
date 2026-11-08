import type { Approval } from './store.ts';

/**
 * Links a proposal to the chat message that asks for it, so that message carries its own Approve and Reject.
 * The brain runs `jarvis-act propose` during a turn and then replies. jarvisd notes each proposal of the turn and,
 * when the reply is stored, writes that reply's turn id on them (approvals.chat_turn). A turn that ends SILENT links
 * nothing, and the next turn starts with an empty list, so a proposal never moves onto a later, unrelated message.
 */
export function makeChatLinks(store: { linkChatTurn(ids: number[], turnId: number): Approval[] }) {
  let ids: number[] = [];
  return {
    /** A brain turn started. */
    turnStarted() { ids = []; },
    /** The gate returned this approval to a `jarvis-act propose` call in the current turn. */
    proposed(a: Approval) { if (a.status === 'pending' && !ids.includes(a.id)) ids.push(a.id); },
    /** The turn ended. `turnId` is the stored Jarvis message, or undefined when nothing was said. Returns the linked rows. */
    replied(turnId: number | undefined): Approval[] {
      const these = ids;
      ids = [];
      return turnId ? store.linkChatTurn(these, turnId) : [];
    },
  };
}
