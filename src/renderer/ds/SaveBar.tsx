import { memo } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';

type SaveBarProps = {
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  error?: string | null;
};

export const SaveBar = memo(({ onSave, dirty, saving, error }: SaveBarProps) => {
  if (!dirty && !error && !saving) {
    return null;
  }

  return (
    <div className="mt-1 flex flex-col gap-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Alert>
        <AlertDescription>{saving ? 'Saving\u2026' : 'Unsaved changes'}</AlertDescription>
        <div className="col-start-2 flex gap-2">
          <Button variant="default" size="sm" onClick={onSave} disabled={!dirty || saving}>
            {saving ? 'Saving\u2026' : 'Save'}
          </Button>
        </div>
      </Alert>
    </div>
  );
});
SaveBar.displayName = 'SaveBar';
