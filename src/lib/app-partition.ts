export function customAppPartition(appId: string): string {
  const safeId = appId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `persist:app-${safeId}`;
}
