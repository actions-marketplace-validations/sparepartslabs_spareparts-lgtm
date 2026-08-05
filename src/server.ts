/**
 * Entry point. Uses Probot's node middleware directly rather than the `probot
 * run` CLI, so the app runs under tsx without a build step.
 */

import { createServer } from 'node:http';

import { Probot, createNodeMiddleware } from 'probot';

import app from './app.ts';

const port = Number(process.env.PORT ?? 3000);

const probot = new Probot({
  appId: process.env.APP_ID!,
  privateKey: process.env.PRIVATE_KEY!,
  secret: process.env.WEBHOOK_SECRET!,
});

const middleware = await createNodeMiddleware(app, { probot });

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  middleware(req, res, () => {
    res.writeHead(404).end();
  });
}).listen(port, () => {
  console.log(`lgtm listening on :${port} (webhooks at /api/github/webhooks)`);
});
