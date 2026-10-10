import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GraphValidationError, parseGraphDocument, parseGraphText } from './graph-document.ts';
import type { GraphDocument } from '../types/graph.ts';

const source = readFileSync(new URL('../../public/examples/gfw-galapagos.json', import.meta.url), 'utf8');
function fixture(): GraphDocument { return JSON.parse(source) as GraphDocument; }

test('the published example preserves its evidence, uncertainty and historical event interval', () => {
  const graph = parseGraphText(source);
  assert.equal(graph.nodes.length, 12);
  assert.equal(graph.edges.length, 15);
  assert.equal(graph.sources.length, 3);
  assert.equal(graph.edges.filter(edge => edge.status === 'inferred').length, 4);
  assert.deepEqual(graph.events.map(event => [event.date, event.endDate]), [
    ['2017-08-05', '2017-08-07'], ['2017-08-13', undefined],
  ]);
  assert.equal(graph.origin, 'published-source');
});

test('a dangling edge is rejected before it can be rendered', () => {
  const graph = fixture();
  graph.edges[0].target = 'absent-vessel';
  assert.throws(() => parseGraphDocument(graph), GraphValidationError);
});

test('unknown evidence references are rejected for objects, relations, events and findings', () => {
  for (const section of ['nodes', 'edges', 'events', 'findings'] as const) {
    const graph = fixture();
    graph[section][0].sourceIds = ['missing-document'];
    assert.throws(() => parseGraphDocument(graph), GraphValidationError, section);
  }
});

test('duplicate object identities are rejected', () => {
  const graph = fixture();
  graph.nodes.push(structuredClone(graph.nodes[0]));
  assert.throws(() => parseGraphDocument(graph), GraphValidationError);
});

test('events require real dates and a chronologically valid interval', () => {
  for (const invalidDate of ['2017-02-30', '2017-13-01', 'yesterday', '2017-08-05T12:00:00']) {
    const graph = fixture();
    graph.events[0].date = invalidDate;
    assert.throws(() => parseGraphDocument(graph), GraphValidationError, invalidDate);
  }
  const reversed = fixture();
  reversed.events[0].endDate = '2017-08-04';
  assert.throws(() => parseGraphDocument(reversed), GraphValidationError);
});

test('source links cannot execute scripts or include credentials', () => {
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,example', 'file:///tmp/example', 'https://name:secret@example.com/']) {
    const graph = fixture();
    graph.sources[0].url = unsafe;
    assert.throws(() => parseGraphDocument(graph), GraphValidationError, unsafe);
  }
});

test('arbitrary object identities and a different graph size work through the same contract', () => {
  const graph: GraphDocument = {
    schemaVersion: '1.0', id: 'custom-project', title: 'Custom graph', question: 'Which source mentions this object?',
    summary: 'User supplied graph.', origin: 'imported', createdAt: '2026-10-10T00:00:00Z', limitations: [],
    groups: [{ id: 'documents', label: 'Documents', color: '#123456' }],
    sources: [{ id: 'source:local', title: 'User document' }],
    nodes: [
      { id: 'object:alpha.42', label: 'Alpha', type: 'custom-kind', group: 'documents', description: '', sourceIds: ['source:local'], properties: { custom: 'value' } },
      { id: 'object_beta-7', label: 'Beta', type: 'another-kind', group: 'documents', description: '', sourceIds: ['source:local'], properties: {} },
    ],
    edges: [{ id: 'relation:one', source: 'object:alpha.42', target: 'object_beta-7', label: 'mentions', description: '', status: 'reported', sourceIds: ['source:local'] }],
    events: [], findings: [],
  };
  assert.deepEqual(parseGraphText(JSON.stringify(graph)), graph);
});

test('invalid JSON is reported as a validation error', () => {
  assert.throws(() => parseGraphText('{"nodes":'), GraphValidationError);
});
