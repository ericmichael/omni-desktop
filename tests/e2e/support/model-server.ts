import { createServer, type Server } from 'node:http';

type DeterministicModelServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

function responsePayload(status: 'in_progress' | 'completed', responseText: string) {
  const output =
    status === 'completed'
      ? [
          {
            id: 'msg_e2e_host_first_message',
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
    id: 'resp_e2e_host_first_message',
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

function responseEvents(responseText: string) {
  const completed = responsePayload('completed', responseText);
  const item = completed.output[0]!;
  return [
    {
      type: 'response.created',
      sequence_number: 0,
      response: responsePayload('in_progress', responseText),
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
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean };
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responsePayload('completed', responseText)));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      for (const event of responseEvents(responseText)) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
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
    close: () => closeServer(server),
  };
}
