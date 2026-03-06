/**
 * Ticket supervisor lifecycle phase — the single source of truth for
 * where a ticket's supervisor is in its lifecycle.
 */
export type TicketPhase =
  | 'idle' // no supervisor activity
  | 'provisioning' // sandbox starting, worktree creating
  | 'connecting' // WebSocket connecting to sandbox
  | 'session_creating' // session.ensure RPC in flight
  | 'ready' // session exists, no active run
  | 'running' // start_run sent, streaming messages
  | 'continuing' // between continuation turns (immediately re-runs)
  | 'awaiting_input' // agent asked for user input, paused
  | 'retrying' // waiting for retry timer before re-run
  | 'error' // terminal error (can retry or reset from here)
  | 'completed'; // all work done

/**
 * Valid phase transitions. Each key maps to the set of phases it can transition to.
 */
const TRANSITIONS: Record<TicketPhase, readonly TicketPhase[]> = {
  idle: ['provisioning'],
  provisioning: ['connecting', 'error', 'idle'],
  connecting: ['session_creating', 'error', 'idle'],
  session_creating: ['ready', 'error', 'idle'],
  ready: ['running', 'idle'],
  running: ['continuing', 'awaiting_input', 'retrying', 'completed', 'idle', 'error'],
  continuing: ['running', 'completed', 'retrying', 'idle', 'error'],
  awaiting_input: ['running', 'idle'],
  retrying: ['running', 'error', 'idle'],
  error: ['provisioning', 'idle'],
  completed: ['idle'],
};

/** Check if a phase transition is valid. */
export const isValidTransition = (from: TicketPhase, to: TicketPhase): boolean => {
  return TRANSITIONS[from].includes(to);
};

/** True if the phase represents active supervisor work (not idle/error/completed). */
export const isActivePhase = (phase: TicketPhase): boolean => {
  return phase !== 'idle' && phase !== 'error' && phase !== 'completed';
};

/** True if the supervisor is actively streaming (running or continuing). */
export const isStreamingPhase = (phase: TicketPhase): boolean => {
  return phase === 'running' || phase === 'continuing';
};

