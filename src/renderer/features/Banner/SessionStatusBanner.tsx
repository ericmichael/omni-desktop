/**
 * Inline status banner shown when an agent process's error carries a
 * structured `kind`. Today we render two surfaces:
 *
 *   - `host-offline` — the laptop hosting a `local:<machineId>` session
 *     dropped its WS to the cloud. The chat keeps its existing messages
 *     but no new ones can land; the banner explains and reassures that
 *     the session will resume when the laptop reconnects.
 *   - `machine-at-capacity` — a fresh start was rejected because the
 *     laptop already has 5 cloud-driven sessions running. Banner offers
 *     stopping one or switching to cloud-ACI.
 *
 * Generic errors (no `kind` / `kind: 'message'`) fall back to the host's
 * own error surface (CodeErrorView, ChatShell `phase: 'error'`); the
 * banner is silent there.
 */
import './Banner.css';

import { TriangleAlert } from 'lucide-react';
import { memo, useCallback } from 'react';

import { classifyAgentError } from '@/lib/provider-config';
import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';
import { openSettingsTab } from '@/renderer/features/SettingsModal/settings-nav';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

const bannerClassName = 'absolute inset-x-0 top-0 z-100 m-2 border-warning/50 bg-warning/10 text-warning shadow-md';

export type SessionStatusBannerProps = {
  status: WithTimestamp<AgentProcessStatus> | undefined;
};

export const SessionStatusBanner = memo(({ status }: SessionStatusBannerProps) => {
  const handleOpenAiSettings = useCallback(() => openSettingsTab('AI'), []);
  if (!status) {
    return null;
  }
  // Computer-as-sandbox: the laptop hosting a `local:<machineId>` session is
  // offline, but the agent keeps RUNNING in the cloud (chat + history stay up).
  // Overlay a non-destructive banner over the still-mounted session rather than
  // tearing it down. Resolves automatically when the laptop reconnects (the
  // cloud rebuilds the sandbox; the `hostOffline` flag clears on the next poll).
  if (status.type === 'running' && status.data.hostOffline) {
    return (
      <Alert className={bannerClassName} role="status">
        <TriangleAlert />
        <AlertTitle>{status.data.hostOfflineMachineLabel ?? 'Your computer'} is offline.</AlertTitle>
        <AlertDescription>
          The agent can&apos;t run tools until it reconnects — it resumes automatically.
        </AlertDescription>
      </Alert>
    );
  }
  if (status.type !== 'error') {
    return null;
  }
  const { kind, machineLabel, message, maxSessions, currentSessions } = status.error;
  if (kind === 'host-offline') {
    return (
      <Alert className={bannerClassName} role="status">
        <TriangleAlert />
        <AlertTitle>{machineLabel ?? 'Your computer'} is offline.</AlertTitle>
        <AlertDescription>The session will resume when it reconnects.</AlertDescription>
      </Alert>
    );
  }
  if (kind === 'machine-at-capacity') {
    return (
      <Alert variant="destructive" className="absolute inset-x-0 top-0 z-100 m-2" role="status">
        <TriangleAlert />
        <AlertTitle>{machineLabel ?? 'Your computer'} is at capacity</AlertTitle>
        <AlertDescription>
          ({currentSessions ?? '?'}/{maxSessions ?? '?'} sessions). Stop one or switch this session to cloud.
        </AlertDescription>
      </Alert>
    );
  }
  // Auth failures get a fix-it path: the user's key/subscription is the
  // problem, and the AI tab's connection cards can diagnose and repair it.
  if (message && classifyAgentError(message) === 'auth') {
    return (
      <Alert variant="destructive" className="omni-status-banner-grid absolute inset-x-0 top-0 z-100 m-2" role="status">
        <TriangleAlert />
        <AlertTitle>Your AI provider rejected the request.</AlertTitle>
        <AlertDescription>The key may have expired or been revoked.</AlertDescription>
        <Button className="col-start-3 row-span-2 row-start-1" size="sm" variant="ghost" onClick={handleOpenAiSettings}>
          Check AI settings
        </Button>
      </Alert>
    );
  }
  // No `kind` set — host-level error UI owns the surface, nothing here.
  return null;
});

SessionStatusBanner.displayName = 'SessionStatusBanner';
