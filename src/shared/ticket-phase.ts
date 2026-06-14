/**
 * Ticket supervisor lifecycle phase — the single source of truth for
 * where a ticket's supervisor is in its lifecycle.
 *
 * The agent-side ``/goal`` loop in omni-code owns continuation, retries,
 * and stall recovery; the launcher just mirrors snapshots back into
 * ticket phase, so the only streaming phase is ``running``.
 */
export type TicketPhase =
  | 'idle' // no supervisor activity
  | 'provisioning' // sandbox starting, worktree creating
  | 'connecting' // WebSocket connecting to sandbox
  | 'session_creating' // session.ensure RPC in flight
  | 'ready' // session exists, no active run
  | 'running' // /goal loop active
  | 'error' // terminal error
  | 'completed'; // all work done

/**
 * Valid phase transitions. Each key maps to the set of phases it can transition to.
 */
const TRANSITIONS: Record<TicketPhase, readonly TicketPhase[]> = {
  idle: ['provisioning', 'connecting'],
  provisioning: ['connecting', 'error', 'idle'],
  connecting: ['session_creating', 'error', 'idle'],
  session_creating: ['ready', 'error', 'idle'],
  ready: ['running', 'idle'],
  running: ['completed', 'idle', 'error'],
  error: ['provisioning', 'idle'],
  completed: ['idle', 'provisioning'],
};

/** Check if a phase transition is valid. */
export const isValidTransition = (from: TicketPhase, to: TicketPhase): boolean => {
  return TRANSITIONS[from].includes(to);
};

/** True if the phase represents active supervisor work (not idle/error/completed). */
export const isActivePhase = (phase: TicketPhase): boolean => {
  return phase !== 'idle' && phase !== 'error' && phase !== 'completed';
};

/** True if the supervisor is actively streaming. */
export const isStreamingPhase = (phase: TicketPhase): boolean => {
  return phase === 'running';
};
