/** Do not acknowledge reset or change identity unless stopping succeeds. */
export async function resetConversation({
  runId,
  stopRun,
  selectNew,
}: {
  runId?: string;
  stopRun: (runId: string) => Promise<void>;
  selectNew: () => void;
}): Promise<void> {
  if (runId) {
    await stopRun(runId);
  }
  selectNew();
}
