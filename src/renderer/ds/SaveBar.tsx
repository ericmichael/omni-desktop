import { memo } from 'react';

import { Button } from '@/renderer/ds/Button';

type SaveBarProps = {
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  error?: string | null;
};

export const SaveBar = memo(({ onSave, dirty, saving, error }: SaveBarProps) => (
  <div className="flex flex-col gap-2 mt-1">
    {error && <span className="text-sm sm:text-xs text-red-400">{error}</span>}
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      <Button
        variant="primary"
        onClick={onSave}
        isDisabled={!dirty || saving}
        className="justify-center h-12 text-base sm:h-9 sm:text-sm sm:w-auto"
      >
        {saving ? 'Saving\u2026' : 'Save'}
      </Button>
      {dirty && (
        <span className="text-sm sm:text-xs text-fg-subtle text-center sm:text-left">Unsaved changes</span>
      )}
    </div>
  </div>
));
SaveBar.displayName = 'SaveBar';
