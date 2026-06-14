/**
 * Per-principal registry of Electron clients available as local compute hosts
 * for the cloud-linked "computer-as-sandbox" feature.
 *
 * Accessed via the ADMIN pool (same as {@link ControlPlaneRepo}): the
 * application is responsible for scoping every call by `principalId`. RLS on
 * the `machines` table is dormant — present so a stray omni_app access would
 * still be principal-isolated — but the admin pool bypasses it.
 */
import type { Pool } from 'pg';

export interface MachineRow {
  machine_id: string;
  principal_id: string;
  label: string;
  platform: string;
  registered_at: string;
  last_seen_at: string;
}

export class MachinesRepo {
  /** @param pool the ADMIN (schema-owner) pool. */
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert a machine for *principalId* — first sight creates the row; later
   * sights refresh `label`/`platform` (a user can rename their machine in
   * Settings and we want the latest value to win) and bump `last_seen_at`.
   */
  async register(principalId: string, info: { machineId: string; label: string; platform: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO machines (machine_id, principal_id, label, platform) VALUES ($1, $2, $3, $4)
       ON CONFLICT (machine_id) DO UPDATE SET
         label = EXCLUDED.label,
         platform = EXCLUDED.platform,
         last_seen_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')`,
      [info.machineId, principalId, info.label, info.platform]
    );
  }

  /** Bump `last_seen_at` (called on WS bind + periodic heartbeat). */
  async touch(principalId: string, machineId: string): Promise<void> {
    await this.pool.query(
      `UPDATE machines SET last_seen_at = to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS.MS')
        WHERE machine_id = $1 AND principal_id = $2`,
      [machineId, principalId]
    );
  }

  async list(principalId: string): Promise<MachineRow[]> {
    const { rows } = await this.pool.query<MachineRow>(
      `SELECT machine_id, principal_id, label, platform, registered_at, last_seen_at
         FROM machines
        WHERE principal_id = $1
        ORDER BY label`,
      [principalId]
    );
    return rows;
  }

  async get(principalId: string, machineId: string): Promise<MachineRow | undefined> {
    const { rows } = await this.pool.query<MachineRow>(
      `SELECT machine_id, principal_id, label, platform, registered_at, last_seen_at
         FROM machines
        WHERE machine_id = $1 AND principal_id = $2`,
      [machineId, principalId]
    );
    return rows[0];
  }

  async rename(principalId: string, machineId: string, label: string): Promise<void> {
    await this.pool.query(`UPDATE machines SET label = $3 WHERE machine_id = $1 AND principal_id = $2`, [
      machineId,
      principalId,
      label,
    ]);
  }

  /**
   * Remove a machine. The caller is responsible for releasing any active WS
   * binding in the {@link MachineRegistry} so a reconnect with the same id
   * doesn't silently re-establish trust.
   */
  async delete(principalId: string, machineId: string): Promise<void> {
    await this.pool.query(`DELETE FROM machines WHERE machine_id = $1 AND principal_id = $2`, [machineId, principalId]);
  }
}
