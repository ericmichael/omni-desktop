import { memo } from 'react';
import type { FallbackProps } from 'react-error-boundary';
import { AssertionError } from 'tsafe';

import { Button } from '@/renderer/ds/ui/button';

const getMessage = (error: unknown) => {
  let errorMessage = '';
  if (error instanceof AssertionError) {
    errorMessage = error.originalMessage ?? error.message;
  } else if (error instanceof Error) {
    errorMessage = error.message;
  }
  return errorMessage || 'An unknown error occurred.';
};

export const ErrorBoundaryFallback = memo(({ error, resetErrorBoundary }: FallbackProps) => {
  const stack = error instanceof Error ? error.stack : undefined;
  return (
    <div className="flex flex-col w-full h-full items-center justify-center gap-4">
      <h2 className="font-display text-lg font-semibold tracking-tight">An error occurred.</h2>
      <h2 className="font-display text-base font-semibold tracking-tight text-destructive">
        Error: {getMessage(error)}
      </h2>
      {stack && (
        <pre className="max-h-48 max-w-2xl overflow-auto whitespace-pre-wrap break-all px-4 text-xs text-muted-foreground">
          {stack}
        </pre>
      )}
      <Button onClick={resetErrorBoundary} className="mt-8">
        Reset
      </Button>
    </div>
  );
});
ErrorBoundaryFallback.displayName = 'ErrorBoundaryFallback';
