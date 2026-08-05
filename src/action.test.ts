import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { resolveEvent, type OctokitLike } from './action.ts';

/** An octokit whose PR head is `sha` and whose reviews are `reviews`. */
function stub(sha: string, reviews: { state: string; commit_id?: string }[]) {
  const asked: unknown[] = [];
  return {
    asked,
    client: {
      rest: { pulls: { get: async (a: unknown) => { asked.push(a); return { data: { head: { sha } } }; }, listReviews: 'listReviews' } },
      paginate: async () => reviews,
    } as unknown as OctokitLike,
  };
}

function artifact(payload: unknown): string {
  const path = `/tmp/lgtm-relay-${Math.abs(Number(process.hrtime.bigint() % 100000n))}.json`;
  writeFileSync(path, JSON.stringify({ event_name: 'pull_request_review', payload }));
  return path;
}

function withRelay<T>(path: string, fn: () => Promise<T>): Promise<T> {
  process.env.LGTM_RELAYED_EVENT = path;
  return fn().finally(() => { delete process.env.LGTM_RELAYED_EVENT; });
}

test('a real approval is reconstructed from the API, not the artifact', async () => {
  // The artifact lies about the reviewer; the API is the source of truth.
  const path = artifact({ pull_request: { number: 7 }, review: { user: { login: 'mallory' } } });
  const { client } = stub('abc', [{ state: 'APPROVED', commit_id: 'abc', user: { login: 'alice' } } as never]);
  const event = await withRelay(path, () => resolveEvent(client, 'o', 'r'));
  assert.ok(event);
  const review = (event!.payload as { review: { user: { login: string } } }).review;
  assert.equal(review.user.login, 'alice', 'the forged reviewer must not survive');
});

test('a forged artifact with no matching approval yields nothing', async () => {
  const path = artifact({ pull_request: { number: 7 }, review: { state: 'approved' } });
  const { client } = stub('abc', []);
  assert.equal(await withRelay(path, () => resolveEvent(client, 'o', 'r')), null);
});

test('an approval of a superseded commit does not count', async () => {
  const path = artifact({ pull_request: { number: 7 } });
  const { client } = stub('newsha', [{ state: 'APPROVED', commit_id: 'oldsha' }]);
  assert.equal(await withRelay(path, () => resolveEvent(client, 'o', 'r')), null);
});

test('non-approval reviews do not count', async () => {
  const path = artifact({ pull_request: { number: 7 } });
  const { client } = stub('abc', [{ state: 'COMMENTED', commit_id: 'abc' }, { state: 'CHANGES_REQUESTED', commit_id: 'abc' }]);
  assert.equal(await withRelay(path, () => resolveEvent(client, 'o', 'r')), null);
});

test('a garbage PR number is refused without an API call', async () => {
  for (const number of [undefined, 'seven', -1, 0, 1.5, { }]) {
    const path = artifact({ pull_request: { number } });
    const { client, asked } = stub('abc', [{ state: 'APPROVED', commit_id: 'abc' }]);
    assert.equal(await withRelay(path, () => resolveEvent(client, 'o', 'r')), null, String(number));
    assert.equal(asked.length, 0, 'no lookup should be attempted');
  }
});

test('the PR number is the only thing taken from the artifact', async () => {
  const path = artifact({ pull_request: { number: 42 } });
  const { client, asked } = stub('abc', [{ state: 'APPROVED', commit_id: 'abc' }]);
  await withRelay(path, () => resolveEvent(client, 'o', 'r'));
  assert.equal((asked[0] as { pull_number: number }).pull_number, 42);
});
