import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRows } from '../src/export.mjs';

test('the existing JSON default remains compatible', () => {
  assert.equal(exportRows([{ name: 'Ada', count: 2 }]), '[{"name":"Ada","count":2}]\n');
  assert.equal(exportRows([]), '[]\n');
});
