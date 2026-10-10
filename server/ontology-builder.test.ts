import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildColumnMappings, buildOntologyDefinition, commerceBlueprintTemplate, ontologyBlueprintSchema, leanOntologyBlueprintSchema } from './ontology-builder.ts';
import { ontologyDefinitionSchema, parseOntologyDefinition } from './ontology-schema.ts';
import { designOntology } from './ontology-planner.ts';

test('compact domain blueprint expands defaults and same-name column mappings without mutating the input', () => {
  const blueprint = commerceBlueprintTemplate(); const original = JSON.stringify(blueprint);
  const definition = buildOntologyDefinition(blueprint, { id: 'ontology-customer-orders', version: 3 });
  assert.equal(definition.id, 'ontology-customer-orders'); assert.equal(definition.version, 3);
  assert.equal(definition.status, 'active'); assert.equal(definition.schemaVersion, '1.0');
  assert.deepEqual(definition.objectTypes.map(type => type.color), ['#54b5af', '#7399d5']);
  assert.equal(definition.objectTypes[0].icon, 'object'); assert.equal(definition.objectTypes[0].properties[0].visibility, 'normal');
  assert.equal(definition.objectTypes[0].properties[0].valueSource, 'evidence');
  assert.deepEqual(definition.sourceMappings[0].columns, [{ column: 'customerId', property: 'customerId' }, { column: 'name', property: 'name' }]);
  assert.deepEqual(definition.objectTypes[0].implementsInterfaces, []);
  assert.equal(JSON.stringify(blueprint), original);
  assert.deepEqual(buildOntologyDefinition(definition), parseOntologyDefinition(definition), 'earlier full definition format remains compatible');
  assert.ok(JSON.stringify(blueprint).length < JSON.stringify(definition).length, 'Codex writes fewer repeated metadata fields');
});

test('compact definitions use the full parser for keys, typed properties, references and executable capability rejection', () => {
  const raw = { blueprintVersion: '1.0', apiName: 'Observations', displayName: '관측', objectTypes: [{ apiName: 'Observation', primaryKey: 'evidenceId', titleProperty: 'label', properties: [
    { apiName: 'evidenceId', baseType: 'string', valueSource: 'evidenceId' },
    { apiName: 'label', baseType: 'string' },
    { apiName: 'position', baseType: 'struct', fields: [{ apiName: 'latitude', baseType: 'double', required: true }, { apiName: 'longitude', baseType: 'double', required: true }] },
  ] }] };
  const built = buildOntologyDefinition(raw);
  assert.equal(built.objectTypes[0].properties[0].required, true);
  assert.equal(built.objectTypes[0].properties[0].valueSource, 'evidenceId');
  assert.equal(built.objectTypes[0].properties[2].fields?.[0].baseType, 'double');
  assert.throws(() => buildOntologyDefinition({ ...raw, blueprintVersion: '2.0' }), /설계도 버전/);
  assert.throws(() => buildOntologyDefinition({ ...raw, id: 'model-controlled-id' }), /정의되지/);
  assert.throws(() => buildOntologyDefinition({ ...raw, extensions: { unknown: [] } }), /확장 리소스/);
  assert.throws(() => buildOntologyDefinition({ ...raw, linkTypes: [{ apiName: 'seenAt', sourceType: 'Observation', targetType: 'Missing', sourceCardinality: 'many', targetCardinality: 'one' }] }), /존재하지/);
  assert.throws(() => buildOntologyDefinition({ ...raw, extensions: { functions: [{ apiName: 'run', executable: true }] } }), /실행 가능한/);
  assert.throws(() => buildOntologyDefinition({ ...raw, sourceMappings: [{ sourceName: 'data.csv', format: 'csv', objectType: 'Observation', columns: ['evidenceId'] }] }), /메타데이터 속성/);
});

test('advanced extensions remain usable through compact interface, group, shared property and value type bindings', () => {
  const result = buildOntologyDefinition({ blueprintVersion: '1.0', apiName: 'Customers', displayName: '고객', objectTypes: [{
    apiName: 'Customer', primaryKey: 'customerId', titleProperty: 'name', implementsInterfaces: ['Named'], groups: ['Commerce'], properties: [
      { apiName: 'customerId', baseType: 'string', valueType: 'CustomerCode' },
      { apiName: 'name', baseType: 'string', sharedProperty: 'sharedName' },
    ],
  }], extensions: {
    sharedProperties: [{ apiName: 'sharedName', baseType: 'string', constraints: { maxLength: 80 } }],
    interfaces: [{ apiName: 'Named', properties: [{ apiName: 'name', baseType: 'string', required: true }] }],
    valueTypes: [{ apiName: 'CustomerCode', baseType: 'string', constraints: { pattern: '^C-[0-9]+$' } }],
    groups: [{ apiName: 'Commerce', displayName: '상거래' }],
    actionTypes: [{ apiName: 'renameCustomer', objectTypes: ['Customer'], parameters: [{ apiName: 'name', baseType: 'string' }] }],
    functions: [{ apiName: 'lookupCustomer', objectTypes: ['Customer'], parameters: [{ apiName: 'customerId', baseType: 'string' }] }],
  } });
  assert.equal(result.objectTypes[0].properties[0].valueType, 'CustomerCode');
  assert.equal(result.objectTypes[0].properties[1].sharedProperty, 'sharedName');
  assert.deepEqual(result.objectTypes[0].implementsInterfaces, ['Named']);
  assert.deepEqual(result.objectTypes[0].groups, ['Commerce']);
  assert.equal(result.actionTypes[0].executable, false); assert.equal(result.functions[0].status, 'draft');
});

test('bulk column helper preserves explicit renames and does not change original mapping objects', () => {
  const renamed = { column: 'Customer ID', property: 'customerId' };
  assert.deepEqual(buildColumnMappings(['name', renamed]), [{ column: 'name', property: 'name' }, renamed]);
  const result = buildColumnMappings([renamed]); result[0].property = 'changed';
  assert.equal(renamed.property, 'customerId');
});

test('compact planning repairs source columns before separately planning advisory classification rules', async () => {
  const blueprint = commerceBlueprintTemplate();
  const mapping = (blueprint.sourceMappings as Record<string, unknown>[])[1];
  mapping.semanticColumns = ['note'];
  const rule = { apiName: 'noteForm', displayName: '메모 유형', purpose: 'classification', sourceName: 'orders.csv', columns: ['note'], question: '기록이 직접 서술인가 재인용인가?', choices: [{ apiName: 'direct', description: '직접 서술' }, { apiName: 'quoted', description: '다른 기록을 재인용' }, { apiName: 'uncertain', description: '근거 부족 또는 복합 서술' }] };
  (blueprint.processing as Record<string, unknown>).decisionRules = [rule];
  assert.deepEqual(buildOntologyDefinition(blueprint).processing.decisionRules, [rule]);
  const original = JSON.stringify(blueprint);
  let calls = 0; let usage = 0;
  const definition = await designOntology({ question: '주문과 메모의 근거를 분석해줘', documents: [{ id: 'orders', name: 'orders.csv', text: 'customerId,name,orderId,amount,note\nC-1,Alice,O-1,10,Customer directly confirmed the order.\nC-2,Bob,O-2,20,The note cites a prior confirmation.' }] }, undefined, async (input, config) => {
    calls++;
    if (input.purpose === 'jev-planning') {
      assert.equal(calls, 3); assert.equal(config?.effort, 'xhigh');
      return { decisionRules: [rule] };
    }
    assert.equal(input.purpose, 'ontology-design');
    assert.equal(config?.effort, 'high');
    assert.match(input.context ?? '', /decisionRules=\[\]/);
    if (calls > 1) { assert.match(input.context ?? '', /원문에 없는 열/); return blueprint; }
    const invalid = structuredClone(blueprint);
    (invalid.sourceMappings as Record<string, unknown>[])[1].semanticColumns = ['absentNote'];
    (invalid.processing as Record<string, unknown>).decisionRules = [{ ...rule, columns: ['absentNote'] }];
    return invalid;
  }, {}, { id: 'ontology-advisory', planJevRules: true, signal: new AbortController().signal, usage: () => { usage++; }, progress: () => {} });
  assert.equal(calls, 3); assert.equal(usage, 3);
  assert.equal(definition.processing.textStrategy, 'codex');
  assert.deepEqual(definition.processing.decisionRules, [rule]);
  assert.equal(JSON.stringify(blueprint), original, 'building and planning do not mutate the blueprint');
});

test('compact output schema stays closed, resolves every definition reference and reduces schema repetition', () => {
  const definitions = ontologyBlueprintSchema.$defs as Record<string, unknown>;
  function check(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(check); return; }
    const schema = value as Record<string, unknown>;
    if (typeof schema.$ref === 'string') {
      assert.match(schema.$ref, /^#\/\$defs\//);
      assert.ok(Object.hasOwn(definitions, schema.$ref.slice('#/$defs/'.length)), `missing schema reference: ${schema.$ref}`);
    }
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties as Record<string, unknown>));
    }
    Object.values(schema).forEach(check);
  }
  check(ontologyBlueprintSchema);
  const bytes = Buffer.byteLength(JSON.stringify(ontologyBlueprintSchema));
  assert.ok(bytes < Buffer.byteLength(JSON.stringify(ontologyDefinitionSchema)) / 2);
  assert.ok(bytes < 200_000);
});

test('ordinary design omits unused property extensions and explicitly retains administrative columns', async () => {
  assert.ok(JSON.stringify(leanOntologyBlueprintSchema).length < JSON.stringify(ontologyBlueprintSchema).length * 0.6);
  const defs = leanOntologyBlueprintSchema.$defs as Record<string, { properties: Record<string, unknown> }>;
  assert.deepEqual(Object.keys(defs.scalar.properties), ['apiName', 'displayName', 'baseType', 'required', 'valueSource']);
  const blueprint = commerceBlueprintTemplate();
  const mapping = (blueprint.sourceMappings as Record<string, unknown>[])[0];
  mapping.retainedColumns = ['importBatch'];
  let calls = 0;
  const result = await designOntology({ question: '고객 주문 관계', documents: [{ id: 'orders', name: 'orders.csv', text: 'customerId,name,orderId,amount,importBatch\nC1,Alex,O1,50,BATCH-1' }] }, undefined, async input => {
    calls++; assert.deepEqual(input.schema, leanOntologyBlueprintSchema); return blueprint;
  }, {}, { id: 'minimal-retained', signal: new AbortController().signal, usage: () => {}, progress: () => {} });
  assert.equal(calls, 1); assert.deepEqual(result.sourceMappings[0].retainedColumns, ['importBatch']);
  assert.ok(!result.objectTypes.some(type => type.properties.some(property => property.apiName === 'importBatch')));
  mapping.retainedColumns = ['customerId'];
  assert.throws(() => buildOntologyDefinition(blueprint), /겹칠 수 없습니다/);
});

test('local builder CLI produces valid JSON and rejects malformed JSON without echoing input or credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cluevia-ontology-builder-'));
  const script = fileURLToPath(new URL('../scripts/build_ontology.py', import.meta.url));
  const run = (args: string[]) => spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', script, ...args], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: 'private-env-marker', OPENAI_API_KEY: 'private-env-marker' } });
  try {
    const template = run(['--template', 'commerce']); assert.equal(template.status, 0, template.stderr);
    const templateJson = JSON.parse(template.stdout); assert.equal(templateJson.blueprintVersion, '1.0');
    const file = join(dir, 'blueprint.json'); writeFileSync(file, template.stdout);
    const built = run([file]); assert.equal(built.status, 0, built.stderr);
    const parsed = parseOntologyDefinition(JSON.parse(built.stdout)); assert.equal(parsed.objectTypes.length, 2);
    assert.doesNotMatch(built.stdout + built.stderr, /private-env-marker/);
    writeFileSync(file, '{"private-input-marker": "unterminated');
    const invalid = run([file]); assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /올바른 JSON/); assert.doesNotMatch(invalid.stderr, /private-input-marker|private-env-marker/);
    const absent = run([join(dir, 'missing.json')]); assert.equal(absent.status, 1); assert.equal(absent.stdout, '');
    assert.match(absent.stderr, /파일을 읽을 수 없습니다/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
