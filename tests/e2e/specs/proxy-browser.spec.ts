import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { expect, test } from 'tests/e2e/fixtures/test';
import { openCode } from 'tests/e2e/support/app';

type TestUpstream = {
  origin: string;
  close: () => Promise<void>;
};

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>Proxy E2E</title></head><body>${body}</body></html>`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

async function startTestUpstream(): Promise<TestUpstream> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/') {
      sendHtml(
        res,
        [
          '<h1>Proxy Test Home</h1>',
          '<a id="next-link" href="/next?via=link">Next page</a>',
          '<button id="fetch-button">Fetch data</button>',
          '<output id="fetch-result"></output>',
          '<button id="xhr-button">XHR data</button>',
          '<output id="xhr-result"></output>',
          '<button id="ws-button">WebSocket data</button>',
          '<output id="ws-result"></output>',
          '<form id="post-form" method="post" action="/submit"><input name="message" value="hello"><button type="submit">Submit form</button></form>',
          '<script>',
          'document.getElementById("fetch-button").addEventListener("click", async () => { const res = await fetch("/api/data?from=fetch"); document.getElementById("fetch-result").textContent = await res.text(); });',
          'document.getElementById("xhr-button").addEventListener("click", () => { const xhr = new XMLHttpRequest(); xhr.onload = () => { document.getElementById("xhr-result").textContent = xhr.responseText; }; xhr.open("GET", "/api/data?from=xhr"); xhr.send(); });',
          'document.getElementById("ws-button").addEventListener("click", () => { const ws = new WebSocket("/ws"); ws.onmessage = (event) => { document.getElementById("ws-result").textContent = event.data; ws.close(); }; });',
          '</script>',
        ].join('\n')
      );
      return;
    }

    if (url.pathname === '/next') {
      sendHtml(res, '<h1>Proxy Test Next</h1><p id="next-marker">arrived via link</p>');
      return;
    }

    if (url.pathname === '/submit') {
      const body = await readBody(req);
      sendHtml(res, `<h1>Proxy Test Submitted</h1><p id="submit-body">${body}</p>`);
      return;
    }

    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`api:${url.searchParams.get('from') ?? 'unknown'}`);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.on('connection', (socket) => {
    socket.send('ws:ok');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function openStandaloneBrowser(page: import('@playwright/test').Page): Promise<void> {
  await openCode(page);
  await page.getByRole('button', { name: 'New' }).first().click();
  await page.getByRole('menuitem', { name: 'Apps' }).click();
  await page.getByRole('button', { name: 'Browser' }).click();
  await expect(page.getByText('Browser').first()).toBeVisible();
  await expect(page.getByPlaceholder('Search or enter URL').first()).toBeVisible();
}

test.describe('browser/server proxy browser', () => {
  test('loads proxied pages while keeping canonical browser state for common operations', async ({ appPage, mode }) => {
    test.skip(mode !== 'server-local', 'browser/server proxy behavior is only exercised in server mode');

    const upstream = await startTestUpstream();
    const upstreamHome = `${upstream.origin}/`;
    try {
      await openStandaloneBrowser(appPage);
      const omnibox = appPage.getByPlaceholder('Search or enter URL').first();
      await omnibox.fill(upstream.origin);
      await omnibox.press('Enter');

      await expect(omnibox).toHaveValue(upstreamHome);
      const iframe = appPage.locator('iframe[src*="/proxy/"]').first();
      await expect(iframe).toBeVisible();
      await expect(iframe).toHaveAttribute('src', /\/proxy\//);
      await expect(iframe).not.toHaveAttribute(
        'src',
        new RegExp(upstream.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      );

      const frame = appPage.frameLocator('iframe[src*="/proxy/"]').first();
      await expect(frame.getByRole('heading', { name: 'Proxy Test Home' })).toBeVisible();

      await frame.locator('#next-link').click();
      await expect(frame.getByRole('heading', { name: 'Proxy Test Next' })).toBeVisible();
      await expect(omnibox).toHaveValue(`${upstream.origin}/next?via=link`);
      await expect(appPage.locator('iframe[src*="/proxy/"]').first()).toHaveAttribute('src', /\/proxy\//);
      await expect(omnibox).not.toHaveValue(/\/proxy\//);

      await omnibox.fill(upstream.origin);
      await omnibox.press('Enter');
      await expect(frame.getByRole('heading', { name: 'Proxy Test Home' })).toBeVisible();

      await frame.locator('#fetch-button').click();
      await expect(frame.locator('#fetch-result')).toHaveText('api:fetch');

      await frame.locator('#xhr-button').click();
      await expect(frame.locator('#xhr-result')).toHaveText('api:xhr');

      await frame.locator('#ws-button').click();
      await expect(frame.locator('#ws-result')).toHaveText('ws:ok');

      await frame.getByRole('button', { name: 'Submit form' }).click();
      await expect(frame.getByRole('heading', { name: 'Proxy Test Submitted' })).toBeVisible();
      await expect(omnibox).toHaveValue(`${upstream.origin}/submit`);
      await expect(omnibox).not.toHaveValue(/\/proxy\//);
    } finally {
      await upstream.close();
    }
  });
});
