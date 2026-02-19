import { memo } from 'react';
import type { FallbackProps } from 'react-error-boundary';
import { AssertionError } from 'tsafe';

import { Button, Heading } from '@/renderer/ds';

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
  return (
    <div className="flex flex-col w-full h-full items-center justify-center gap-4">
      <Heading>An error occurred.</Heading>
      <Heading size="sm" className="text-fg-error">
        Error: {getMessage(error)}
      </Heading>
      <Button onClick={resetErrorBoundary} className="mt-8">
        Reset
      </Button>
    </div>
  );
});
ErrorBoundaryFallback.displayName = 'ErrorBoundaryFallback';
