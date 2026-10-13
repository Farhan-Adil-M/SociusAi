// Core ID generation: server-minted, format-stable, unpredictable (3.7).

import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../server/store/sqlite.js';

test('newId keeps the prefix + hex format and is unpredictably random', () => {
  const id = newId('src');
  assert.match(id, /^src_[(\d)a-f]{12}$/);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const other = newId('test');
    assert.ok(!seen.has(other), 'ids collide — randomBytes must not repeat in practice');
    seen.add(other);
  }
});
