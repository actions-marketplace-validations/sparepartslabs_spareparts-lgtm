/**
 * First-run entry point: `npm run setup`.
 *
 * Probot's `run()` notices there is no APP_ID and serves its manifest wizard
 * instead of the app. The wizard hands GitHub the permission set from
 * `app.yml`, GitHub hands back the credentials, and Probot writes them to
 * `.env` — so the App is registered without anyone transcribing a private key.
 *
 * Once `.env` has APP_ID and PRIVATE_KEY, use `npm run dev` instead; this file
 * is only for the registration step.
 */

import { run } from 'probot';

import app from './app.ts';

await run(app);
