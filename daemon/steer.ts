import type { Approval } from './store.ts';
import type { Gate } from './gate.ts';
import type { WorkRow } from './work.ts';

// The Stop button under the conversation pane. The message box above it types into a native worker directly (workroutes.ts).

export type SteerResult = { status: number; body: { approval?: Approval; error?: string } };

/** The pane's Stop button. Stopping a worker needs the owner's Approve on the card it opens. */
export async function stop(row: WorkRow, gate: Pick<Gate, 'propose'>): Promise<SteerResult> {
  if (row.kind !== 'worker' || !row.dispatch) return { status: 409, body: { error: 'Only a supervised worker can be stopped from here.' } };
  try {
    return { status: 200, body: { approval: await gate.propose('worker-stop', { dispatch: row.dispatch }, `Stop "${row.title.slice(0, 60)}"?`) } };
  } catch (e) {
    return { status: 409, body: { error: (e as Error).message } };
  }
}
