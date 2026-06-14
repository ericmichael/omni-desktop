import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { Body1, Body1Strong, Button, Caption1, SectionLabel } from '@/renderer/ds';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', ...shorthands.gap('20px'), ...shorthands.padding('4px') },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.gap('8px'),
    ...shorthands.padding('8px', '10px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowActive: { ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1) },
  inviteForm: { display: 'flex', ...shorthands.gap('8px'), alignItems: 'center' },
  input: {
    flex: 1,
    ...shorthands.padding('6px', '8px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
});

const TeamRow = memo(function TeamRow({
  team,
  active,
  onSwitch,
}: {
  team: TeamSummary;
  active: boolean;
  onSwitch: (id: string) => void;
}) {
  const styles = useStyles();
  const handle = useCallback(() => onSwitch(team.id), [onSwitch, team.id]);
  return (
    <div className={active ? `${styles.row} ${styles.rowActive}` : styles.row}>
      <div>
        <Body1Strong>{team.label}</Body1Strong> <Caption1>· {team.role}</Caption1>
      </div>
      {active ? (
        <Caption1>Active</Caption1>
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
  const styles = useStyles();
  const handleRemove = useCallback(() => onRemove(member.userId), [onRemove, member.userId]);
  const handleTransfer = useCallback(() => onTransfer(member.userId), [onTransfer, member.userId]);
  return (
    <div className={styles.row}>
      <div>
        <Body1>{member.displayName ?? member.email ?? member.userId}</Body1> <Caption1>· {member.role}</Caption1>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
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
  const styles = useStyles();
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
      <div className={styles.root}>
        <Body1>Teams are available in the hosted (cloud) deployment.</Body1>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div>
        <SectionLabel>Your teams</SectionLabel>
        {teams.map((t) => (
          <TeamRow key={t.id} team={t} active={t.id === activeTeamId} onSwitch={handleSwitch} />
        ))}
        <div className={styles.inviteForm}>
          <input className={styles.input} placeholder="New team name" value={newTeam} onChange={handleNewTeamChange} />
          <Button onClick={handleCreate}>Create team</Button>
        </div>
        <div className={styles.inviteForm}>
          <input
            className={styles.input}
            placeholder="Paste an invite code to join a team"
            value={acceptToken}
            onChange={handleAcceptChange}
          />
          <Button onClick={handleAccept}>Join</Button>
        </div>
      </div>

      <div>
        <SectionLabel>Members</SectionLabel>
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

      {activeTeam ? (
        <div>
          <SectionLabel>Manage “{activeTeam.label}”</SectionLabel>
          {isAdmin ? (
            <div className={styles.inviteForm}>
              <input
                className={styles.input}
                placeholder="Rename team…"
                value={renameValue}
                onChange={handleRenameChange}
              />
              <Button onClick={handleRename}>Rename</Button>
            </div>
          ) : null}
          <div className={styles.inviteForm}>
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
      ) : null}

      {isAdmin ? (
        <div>
          <SectionLabel>Invite a member</SectionLabel>
          <div className={styles.inviteForm}>
            <input
              className={styles.input}
              placeholder="email@example.com"
              value={inviteEmail}
              onChange={handleInviteChange}
            />
            <Button onClick={handleInvite}>Invite</Button>
          </div>
          {invites.map((inv) => (
            <InviteRow key={inv.id} email={inv.email} id={inv.id} token={inv.token} />
          ))}
        </div>
      ) : null}

      {isAdmin ? (
        <div>
          <SectionLabel>Team defaults</SectionLabel>
          <Caption1>
            Shared agent config for everyone on the team{' '}
            {defaults.hasModels || defaults.hasMcp || defaults.hasEnv || defaults.hasNetwork
              ? '· configured'
              : '· not set (members use their own)'}
          </Caption1>
          <div className={styles.inviteForm}>
            <Button onClick={handlePublishDefaults}>Publish my config as team default</Button>
            <Button variant="ghost" onClick={handleClearDefaults}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

const InviteRow = memo(function InviteRow({ email, id, token }: { email: string; id: string; token: string }) {
  const styles = useStyles();
  const handleRevoke = useCallback(() => void revokeInvite(id), [id]);
  const handleCopy = useCallback(() => void navigator.clipboard?.writeText(token), [token]);
  return (
    <div className={styles.row}>
      <Caption1>{email} · pending</Caption1>
      <div style={{ display: 'flex', gap: 6 }}>
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
