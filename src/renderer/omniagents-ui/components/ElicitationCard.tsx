import { ExternalLinkIcon, ShieldQuestionIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/renderer/ds/ui/card';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Input } from '@/renderer/ds/ui/input';
import { Label } from '@/renderer/ds/ui/label';
import { RadioGroup, RadioGroupItem } from '@/renderer/ds/ui/radio-group';
import type { ElicitationRequest, ElicitationResponse } from '@/renderer/omniagents-ui/rpc/elicitation';

type Props = {
  request: ElicitationRequest;
  onRespond: (response: ElicitationResponse) => Promise<unknown>;
};

type PrimitiveSchema = {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  writeOnly?: unknown;
  format?: unknown;
};

function schemaProperties(request: ElicitationRequest): Array<[string, PrimitiveSchema]> {
  if (request.kind !== 'form') {
    return [];
  }
  const properties = request.inputSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }
  return Object.entries(properties).map(([name, value]) => [
    name,
    value && typeof value === 'object' && !Array.isArray(value) ? (value as PrimitiveSchema) : {},
  ]);
}

function initialFormValue(properties: Array<[string, PrimitiveSchema]>): Record<string, unknown> {
  return Object.fromEntries(
    properties
      .filter(([, schema]) => schema.default !== undefined || schema.type === 'boolean')
      .map(([name, schema]) => [name, schema.default ?? false])
  );
}

export function ElicitationCard({ request, onRespond }: Props) {
  const properties = useMemo(() => schemaProperties(request), [request]);
  const [question, setQuestion] = useState('');
  const [selectedIndex, setSelectedIndex] = useState('');
  const [formValue, setFormValue] = useState<Record<string, unknown>>(() => initialFormValue(properties));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (response: ElicitationResponse) => {
    setSubmitting(true);
    setError(null);
    try {
      await onRespond(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the response');
      setSubmitting(false);
    }
  };

  const accept = () => {
    if (request.kind === 'question') {
      return respond({ action: 'accept', value: { text: question } });
    }
    if (request.kind === 'select') {
      const index = Number(selectedIndex);
      const option = Number.isInteger(index) ? request.options[index] : undefined;
      return respond({ action: 'accept', value: { selected: option ? [option.value] : [] } });
    }
    if (request.kind === 'form') {
      return respond({ action: 'accept', value: formValue });
    }
    return respond({ action: 'accept', value: {} });
  };

  return (
    <Card className="mx-3 mb-2 gap-3 border-primary/30 bg-card/95 py-4 shadow-sm" data-testid="elicitation-card">
      <CardHeader className="gap-1 px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldQuestionIcon className="size-4 text-primary" aria-hidden="true" />
          {request.title || 'Input needed'}
        </CardTitle>
        <CardDescription>{request.message}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3 px-4">
        {request.kind === 'question' && (
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Type your answer"
            disabled={submitting}
            aria-label={request.title || request.message}
            autoFocus
          />
        )}

        {request.kind === 'select' && (
          <RadioGroup value={selectedIndex} onValueChange={setSelectedIndex} disabled={submitting}>
            {request.options.map((option, index) => (
              <Label
                key={index}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-accent/50"
              >
                <RadioGroupItem value={String(index)} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.label}</span>
                  {option.description && (
                    <span className="block text-xs font-normal text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </Label>
            ))}
          </RadioGroup>
        )}

        {request.kind === 'form' &&
          properties.map(([name, schema]) => {
            const label = typeof schema.title === 'string' ? schema.title : name;
            const description = typeof schema.description === 'string' ? schema.description : undefined;
            if (schema.type === 'boolean') {
              return (
                <Label key={name} className="flex items-center gap-2">
                  <Checkbox
                    checked={formValue[name] === true}
                    onCheckedChange={(checked) => setFormValue((value) => ({ ...value, [name]: checked === true }))}
                    disabled={submitting}
                  />
                  <span>{label}</span>
                </Label>
              );
            }
            const numeric = schema.type === 'number' || schema.type === 'integer';
            const masked = schema.writeOnly === true || schema.format === 'password';
            return (
              <div key={name} className="space-y-1.5">
                <Label htmlFor={`${request.elicitationId}-${name}`}>{label}</Label>
                <Input
                  id={`${request.elicitationId}-${name}`}
                  type={masked ? 'password' : numeric ? 'number' : 'text'}
                  value={
                    typeof formValue[name] === 'string' || typeof formValue[name] === 'number' ? formValue[name] : ''
                  }
                  onChange={(event) =>
                    setFormValue((value) => ({
                      ...value,
                      [name]: numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value,
                    }))
                  }
                  disabled={submitting}
                />
                {description && <p className="text-xs text-muted-foreground">{description}</p>}
              </div>
            );
          })}

        {request.kind === 'url' && (
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between"
            onClick={() => window.open(request.url, '_blank', 'noopener,noreferrer')}
            disabled={submitting}
          >
            Open secure handoff
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
          </Button>
        )}

        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>

      <CardFooter className="justify-end gap-2 px-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void respond({ action: 'decline', reason: 'user_declined' })}
          disabled={submitting}
        >
          Decline
        </Button>
        {request.kind === 'confirm' ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void respond({ action: 'accept', value: { confirmed: false } })}
              disabled={submitting}
            >
              No
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void respond({ action: 'accept', value: { confirmed: true } })}
              disabled={submitting}
            >
              Yes
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => void accept()}
            disabled={
              submitting ||
              (request.kind === 'question' && question.trim().length === 0) ||
              (request.kind === 'select' && selectedIndex === '')
            }
          >
            {request.kind === 'url' ? 'Done' : 'Submit'}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
