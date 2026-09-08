import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Button } from '@/renderer/ds/ui/button';

export function StartupError({ title, error }: { title: string; error: string }) {
  return (
    <div className="flex items-center justify-center w-full h-full p-8">
      <Alert variant="destructive" className="max-w-md">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p>{error}</p>
          <p>If your session expired, sign in again, then reload.</p>
          <Button variant="outline" onClick={() => location.reload()}>
            Reload
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
