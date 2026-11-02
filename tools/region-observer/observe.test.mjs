import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDatacenter, pickRegion } from './observe.mjs';

test('accepts only safe numeric datacenter IDs', () => {
  assert.equal(normalizeDatacenter(42),'42');
  assert.equal(normalizeDatacenter(' 42 '),'42');
  assert.equal(normalizeDatacenter(-1),null);
  assert.equal(normalizeDatacenter('0 OR 1=1'),null);
  assert.equal(normalizeDatacenter({value:42}),null);
});

test('resolves one exact public RoValra datacenter ID', () => {
  const records=[
    {dataCenterIds:[42,43],location:{city:'Frankfurt',region:'Hesse',country:'DE'}},
    {dataCenterIds:[55],location:{city:'Singapore',region:'',country:'SG'}}
  ];
  assert.deepEqual(pickRegion(records,'42'),{city:'Frankfurt',region:'Hesse',country:'DE'});
  assert.deepEqual(pickRegion(records,'55'),{city:'Singapore',region:'',country:'SG'});
  assert.equal(pickRegion(records,'99'),null);
});

test('refuses to guess when datacenter ID has conflicting locations', () => {
  assert.equal(pickRegion([
    {dataCenterIds:[42],location:{city:'Frankfurt',region:'Hesse',country:'DE'}},
    {dataCenterIds:[42],location:{city:'Berlin',region:'Berlin',country:'DE'}}
  ],'42'),null);
});

test('does not assign missing or invalid country', () => {
  assert.equal(pickRegion([{dataCenterIds:[42],location:{city:'Somewhere'}}],'42'),null);
  assert.equal(pickRegion(null,'42'),null);
});
