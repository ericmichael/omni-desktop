import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

type DeterministicModelServer = {
  baseUrl: string;
  close: () => Promise<void>;
  releaseBackground: () => void;
  observations: { marker: string; model: string }[];
};

function responsePayload(status: 'in_progress' | 'completed', responseText: string, responseId: string) {
  const output =
    status === 'completed'
      ? [
          {
            id: `msg_${responseId}`,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: responseText,
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ]
      : [];
  return {
    id: `resp_${responseId}`,
    created_at: 1,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: 'gpt-5.2',
    object: 'response',
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    status,
    temperature: null,
    top_p: null,
    usage:
      status === 'completed'
        ? {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          }
        : null,
  };
}

function responseEvents(responseText: string, responseId: string) {
  const completed = responsePayload('completed', responseText, responseId);
  const item = completed.output[0]!;
  return [
    {
      type: 'response.created',
      sequence_number: 0,
      response: responsePayload('in_progress', responseText, responseId),
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 2,
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: responseText,
      logprobs: [],
    },
    {
      type: 'response.output_item.done',
      sequence_number: 3,
      output_index: 0,
      item,
    },
    {
      type: 'response.completed',
      sequence_number: 4,
      response: completed,
    },
  ];
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startDeterministicModelServer(responseText: string): Promise<DeterministicModelServer> {
  let releaseBackground!: () => void;
  const backgroundReleased = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
  const observations: { marker: string; model: string }[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.2', object: 'model', created: 1, owned_by: 'e2e' }] })
      );
      return;
    }

    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: `Unexpected model request: ${request.method} ${request.url}` } })
      );
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const responseId = randomUUID();
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.includes('BACKGROUND_LIFECYCLE_GATE')) {
        await backgroundReleased;
        if (response.destroyed) {
          return;
        }
      }
      const body = JSON.parse(raw) as {
        stream?: boolean;
        model?: string;
        input?: { role?: string; content?: unknown }[];
      };
      const latestUser = Array.isArray(body.input) ? body.input.filter((item) => item.role === 'user').at(-1) : null;
      const marker = JSON.stringify(latestUser?.content ?? '').match(/SOAK_\d+_(?:ACCEPTED|RESTORED|SWITCHED)/)?.[0];
      if (marker) {
        observations.push({ marker, model: body.model ?? '' });
      }
      const queuedImage = raw.includes('data:image/png;base64,');
      const questionTile = raw.includes('TILE_QUESTION_A') ? 'A' : raw.includes('TILE_QUESTION_B') ? 'B' : null;
      const approvalTile = raw.match(/TILE_APPROVAL_([ABC])/)?.[1] ?? null;
      const asksForImage = raw.includes('ASK_WITH_IMAGE') || Boolean(questionTile);
      const tile = raw.includes('TILE_UI_A') ? 'A' : raw.includes('TILE_UI_B') ? 'B' : null;
      const updated = raw.includes('UPDATE_TILE_UI');
      const stage = updated ? 'updated' : 'initial';
      const artifactCall = `e2e_artifact_${tile}_${stage}`;
      const planCall = `e2e_plan_${tile}_${stage}`;
      const approvalCall = JSON.stringify(latestUser?.content ?? '').includes('QUEUE_UNCERTAIN')
        ? 'e2e_approval_queued'
        : 'e2e_approval_shared';
      const repeatedTool = JSON.stringify(latestUser?.content ?? '').match(/REPEAT_TOOL_[12]/)?.[0];
      const turnInput = latestUser && body.input ? body.input.slice(body.input.lastIndexOf(latestUser)) : [];
      const tileTool =
        JSON.stringify(latestUser?.content ?? '').includes('STOP_EXECUTOR_TREE') &&
        !JSON.stringify(turnInput).includes('e2e_stop_executor')
          ? {
              callId: 'e2e_stop_executor',
              name: 'execute_bash',
              args: {
                command: `python -c 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)","OMNI_EXECUTOR_CHILD"]); time.sleep(120)' OMNI_EXECUTOR_PARENT`,
                timeout: 180,
              },
            }
          : repeatedTool && !JSON.stringify(turnInput).includes('e2e_repeat_shared')
            ? {
                callId: 'e2e_repeat_shared',
                name: 'execute_bash',
                args: { command: `python -c 'print("${repeatedTool}_RESULT")'` },
              }
            : approvalTile && !raw.includes(approvalCall)
              ? {
                  callId: approvalCall,
                  name: 'execute_bash',
                  args: { command: `python -c 'print("TILE_APPROVAL_${approvalTile}")'` },
                }
              : tile && !raw.includes(artifactCall)
                ? {
                    callId: artifactCall,
                    name: 'display_artifact',
                    args: {
                      title: `${tile} artifact`,
                      content: `${tile}_ARTIFACT_${stage}`,
                      mode: 'markdown',
                      artifact_id: 'shared-report',
                    },
                  }
                : tile && !raw.includes(planCall)
                  ? {
                      callId: planCall,
                      name: updated ? 'task_update' : 'task_create',
                      args: {
                        ...(updated ? { task_id: '1' } : {}),
                        subject: `${tile}_PLAN_${stage}`,
                        description: `Plan owned by tile ${tile}`,
                      },
                    }
                  : null;
      if (tileTool || (asksForImage && !raw.includes('e2e_escalate'))) {
        const item = {
          id: `fc_${tileTool?.callId ?? 'e2e_escalate'}`,
          type: 'function_call',
          call_id: tileTool?.callId ?? 'e2e_escalate',
          name: tileTool?.name ?? 'escalate',
          arguments: JSON.stringify(
            tileTool?.args ?? {
              message: questionTile ? `Question for tile ${questionTile}` : 'Please attach the requested image',
            }
          ),
          status: 'completed',
        };
        const completed = { ...responsePayload('completed', '', responseId), output: [item] };
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completed));
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const event of [
            { type: 'response.created', sequence_number: 0, response: responsePayload('in_progress', '', responseId) },
            {
              type: 'response.output_item.added',
              sequence_number: 1,
              output_index: 0,
              item: { ...item, arguments: '', status: 'in_progress' },
            },
            {
              type: 'response.function_call_arguments.delta',
              sequence_number: 2,
              output_index: 0,
              item_id: item.id,
              delta: item.arguments,
            },
            { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
            { type: 'response.completed', sequence_number: 4, response: completed },
          ]) {
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          response.end('data: [DONE]\n\n');
        }
        return;
      }
      const sessionA = raw.includes('WAIT_FOR_SESSION_A');
      const text = queuedImage
        ? asksForImage
          ? 'ESCALATION_IMAGE_RECEIVED'
          : 'QUEUED_IMAGE_RECEIVED'
        : sessionA
          ? 'SESSION_A_REPLY'
          : raw.includes('PROMPT_FOR_SESSION_B')
            ? 'SESSION_B_REPLY'
            : responseText;
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        const finish = () => response.end(JSON.stringify(responsePayload('completed', text, responseId)));
        if ((raw.includes('WAIT_FOR_QUEUED_IMAGE') && !queuedImage) || sessionA) {
          setTimeout(finish, 20000);
        } else {
          finish();
        }
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      if (sessionA && raw.includes('SOAK_')) {
        // Real partial streaming during the lifecycle soak, not merely a
        // delayed complete response. Reconnects must preserve and reconcile it.
        const events = responseEvents(text, responseId);
        const write = (event: object) =>
          response.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
        write(events[0]!);
        write(events[1]!);
        write({ ...events[2], delta: text.slice(0, 8), sequence_number: 2 });
        const timer = setTimeout(() => {
          write({ ...events[2], delta: text.slice(8), sequence_number: 3 });
          write({ ...events[3], sequence_number: 4 });
          write({ ...events[4], sequence_number: 5 });
          response.end('data: [DONE]\n\n');
        }, 20_000);
        response.once('close', () => clearTimeout(timer));
        return;
      }
      const finish = () => {
        for (const event of responseEvents(text, responseId)) {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      };
      if ((raw.includes('WAIT_FOR_QUEUED_IMAGE') && !queuedImage) || sessionA) {
        setTimeout(finish, 20000);
      } else {
        finish();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Deterministic model server did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    observations,
    releaseBackground,
    close: () => {
      releaseBackground();
      return closeServer(server);
    },
  };
}
