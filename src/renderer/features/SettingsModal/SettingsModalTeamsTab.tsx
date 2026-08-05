import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { SettingsPane, SettingsSection } from '@/renderer/features/SettingsModal/SettingsLayout';
import {
  $activeTeamId,
  $invites,
  $members,
  $myRole,
  $teamDefaults,
  $teams,
  acceptInvite,
  clearTeamDefaults,
  createTeam,
  deleteTeam,
  inviteMember,
  leaveTeam,
  loadInvites,
  loadMembers,
  loadTeamDefaults,
  loadTeams,
  publishTeamDefaults,
  removeMember,
  renameTeam,
  revokeInvite,
  switchTeam,
  transferOwnership,
} from '@/renderer/features/Teams/state';
import type { TeamMember, TeamSummary } from '@/shared/types';

const TeamRow = memo(function TeamRow({
  team,
  active,
  onSwitch,
}: {
  team: TeamSummary;
  active: boolean;
  onSwitch: (id: string) => void;
}) {
  const handle = useCallback(() => onSwitch(team.id), [onSwitch, team.id]);
  return (
    <div
      className={
        active
          ? `${'flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-border bg-card'} ${'border-primary'}`
          : 'flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-border bg-card'
      }
    >
      <div>
        <span className="text-sm font-semibold">{team.label}</span>{' '}
        <span className="text-xs text-muted-foreground">· {team.role}</span>
      </div>
      {active ? (
        <span className="text-xs text-muted-foreground">Active</span>
      ) : (
        <Button size="sm" onClick={handle}>
          Switch
        </Button>
      )}
    </div>
  );
});

const MemberRow = memo(function MemberRow({
  member,
  canManage,
  isOwner,
  onRemove,
  onTransfer,
}: {
  member: TeamMember;
  canManage: boolean;
  isOwner: boolean;
  onRemove: (userId: string) => void;
  onTransfer: (userId: string) => void;
}) {
  const handleRemove = useCallback(() => onRemove(member.userId), [onRemove, member.userId]);
  const handleTransfer = useCallback(() => onTransfer(member.userId), [onTransfer, member.userId]);
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-border bg-card">
      <div>
        <span className="text-sm">{member.displayName ?? member.email ?? member.userId}</span>{' '}
        <span className="text-xs text-muted-foreground">· {member.role}</span>
      </div>
      <div className="flex gap-1.5">
        {isOwner && member.role !== 'owner' ? (
          <Button size="sm" variant="ghost" onClick={handleTransfer}>
            Make owner
          </Button>
        ) : null}
        {canManage && member.role !== 'owner' ? (
          <Button size="sm" onClick={handleRemove}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
});

export const SettingsModalTeamsTab = memo(function SettingsModalTeamsTab() {
  const teams = useStore($teams);
  const activeTeamId = useStore($activeTeamId);
  const myRole = useStore($myRole);
  const members = useStore($members);
  const invites = useStore($invites);
  const defaults = useStore($teamDefaults);
  const [newTeam, setNewTeam] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [acceptToken, setAcceptToken] = useState('');
  const [renameValue, setRenameValue] = useState('');

  const isAdmin = myRole === 'admin' || myRole === 'owner';
  const isOwner = myRole === 'owner';
  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const canDelete = isOwner && activeTeam?.kind !== 'personal';

  useEffect(() => {
    void loadTeams();
    void loadMembers();
    void loadInvites();
    void loadTeamDefaults();
  }, []);

  const handlePublishDefaults = useCallback(() => void publishTeamDefaults(), []);
  const handleClearDefaults = useCallback(() => void clearTeamDefaults(), []);

  const handleSwitch = useCallback((id: string) => switchTeam(id), []);
  const handleRemove = useCallback((userId: string) => void removeMember(userId), []);
  const handleTransfer = useCallback((userId: string) => void transferOwnership(userId), []);
  const handleLeave = useCallback(() => void leaveTeam(), []);
  const handleDelete = useCallback(() => void deleteTeam(), []);
  const handleRename = useCallback(() => {
    if (renameValue.trim()) {
      void renameTeam(renameValue.trim()).then(() => setRenameValue(''));
    }
  }, [renameValue]);
  const handleAccept = useCallback(() => {
    if (acceptToken.trim()) {
      void acceptInvite(acceptToken.trim()).then(() => setAcceptToken(''));
    }
  }, [acceptToken]);
  const handleCreate = useCallback(() => {
    if (newTeam.trim()) {
      void createTeam(newTeam.trim()).then(() => setNewTeam(''));
    }
  }, [newTeam]);
  const handleInvite = useCallback(() => {
    if (inviteEmail.trim()) {
      void inviteMember(inviteEmail.trim(), 'member').then(() => setInviteEmail(''));
    }
  }, [inviteEmail]);
  const handleNewTeamChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setNewTeam(e.target.value), []);
  const handleRenameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value),
    []
  );
  const handleAcceptChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setAcceptToken(e.target.value),
    []
  );
  const handleInviteChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value),
    []
  );

  if (teams.length === 0) {
    return (
      <SettingsPane>
        <SettingsSection title="Teams">
          <span className="text-sm text-muted-foreground">Teams are available in the hosted deployment.</span>
        </SettingsSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <SettingsSection title="Your teams">
        <div className="flex flex-col gap-2">
          {teams.map((t) => (
            <TeamRow key={t.id} team={t} active={t.id === activeTeamId} onSwitch={handleSwitch} />
          ))}
          <InputGroup>
            <InputGroupInput placeholder="New team name" value={newTeam} onChange={handleNewTeamChange} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={handleCreate}>Create team</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup>
            <InputGroupInput
              placeholder="Paste an invite code to join a team"
              value={acceptToken}
              onChange={handleAcceptChange}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={handleAccept}>Join</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </SettingsSection>

      <SettingsSection title="Members">
        <div className="flex flex-col gap-2">
          {members.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              canManage={isAdmin}
              isOwner={isOwner}
              onRemove={handleRemove}
              onTransfer={handleTransfer}
            />
          ))}
        </div>
      </SettingsSection>

      {activeTeam ? (
        <SettingsSection title={`Manage “${activeTeam.label}”`}>
          <div className="flex flex-col gap-2">
            {isAdmin ? (
              <InputGroup>
                <InputGroupInput placeholder="Rename team…" value={renameValue} onChange={handleRenameChange} />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={handleRename}>Rename</InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            ) : null}
            <div className="flex gap-2 items-center">
              {activeTeam.kind !== 'personal' && myRole !== 'owner' ? (
                <Button variant="ghost" onClick={handleLeave}>
                  Leave team
                </Button>
              ) : null}
              {canDelete ? (
                <Button variant="ghost" onClick={handleDelete}>
                  Delete team
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {isAdmin ? (
        <SettingsSection title="Invite a member">
          <div className="flex flex-col gap-2">
            <InputGroup>
              <InputGroupInput placeholder="email@example.com" value={inviteEmail} onChange={handleInviteChange} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={handleInvite}>Invite</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {invites.map((inv) => (
              <InviteRow key={inv.id} email={inv.email} id={inv.id} token={inv.token} />
            ))}
          </div>
        </SettingsSection>
      ) : null}

      {isAdmin ? (
        <SettingsSection title="Team defaults">
          <span className="text-sm text-muted-foreground">
            Shared agent config for everyone on the team{' '}
            {defaults.hasModels || defaults.hasMcp || defaults.hasEnv || defaults.hasNetwork
              ? '· configured'
              : '· not set (members use their own)'}
          </span>
          <div className="flex gap-2 items-center">
            <Button onClick={handlePublishDefaults}>Publish my config as team default</Button>
            <Button variant="ghost" onClick={handleClearDefaults}>
              Clear
            </Button>
          </div>
        </SettingsSection>
      ) : null}
    </SettingsPane>
  );
});

const InviteRow = memo(function InviteRow({ email, id, token }: { email: string; id: string; token: string }) {
  const handleRevoke = useCallback(() => void revokeInvite(id), [id]);
  const handleCopy = useCallback(() => void navigator.clipboard?.writeText(token), [token]);
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-border bg-card">
      <span className="text-xs text-muted-foreground">{email} · pending</span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" onClick={handleCopy}>
          Copy invite code
        </Button>
        <Button size="sm" onClick={handleRevoke}>
          Revoke
        </Button>
      </div>
    </div>
  );
});
