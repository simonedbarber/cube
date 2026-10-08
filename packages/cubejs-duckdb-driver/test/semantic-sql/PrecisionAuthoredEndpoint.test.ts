import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

type Fixture = {
  id: string;
  query: string;
  sql: string;
  document: unknown;
  ir: unknown;
  fields: Array<{ name: string; column_type: string }>;
  expectedRows: Array<Array<string | null>>;
};

/** Actual production-compiler output. No handwritten candidate SQL, result
 * formatting or float tolerance. Public admission remains independently gated. */
describe('Compiler-authored decimals through native SQL HTTP', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  let packet: { fixtureSha256: string; emitterSha256: string; compilerRevision: number; originalModelSourceSha256: string; setupSQL: string; cases: Fixture[] };
  beforeAll(async () => {
    const authoredPath = process.env.QUERYRAILS_MC18_AUTHORED_PACKET_PATH;
    const modelPath = process.env.QUERYRAILS_MC18_GENERATED_MODEL_PATH;
    if (!authoredPath || !modelPath) throw new Error('Generate compiler candidates and the production numeric model before native capture');
    packet = JSON.parse(readFileSync(authoredPath, 'utf8'));
    const generated = JSON.parse(readFileSync(modelPath, 'utf8'));
    expect(packet.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.emitterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.compilerRevision).toBe(3);
    expect(packet.originalModelSourceSha256).toBe(generated.originalModelSourceSha256);
    expect(generated.declarations).toHaveLength(15);
    expect(packet.cases).toHaveLength(6);
    endpoint = await startSemanticSqlEndpoint({
      model: () => generated.typedModelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['analyst', ['semantic_analyst']]]) });
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each(['SYN-MC18-AUTHORED-SAFE-DIVISION', 'SYN-MC18-AUTHORED-DECIMAL-ARITHMETIC', 'SYN-MC18-AUTHORED-EXACT-LARGE-INTEGER', 'SYN-MC18-AUTHORED-REFERENCE-ADD', 'SYN-MC18-AUTHORED-REFERENCE-SUBTRACT', 'SYN-MC18-AUTHORED-REPRESENTABLE-CARRY'])(
    '%s retains exact values, output types and authorized source inputs', async id => {
      const fixture = packet.cases.find(candidate => candidate.id === id);
      if (!fixture) throw new Error(`Missing compiler-authored fixture ${id}`);
      expect(fixture.document).toBeDefined();
      expect(fixture.ir).toBeDefined();
      expect(fixture.query).not.toMatch(/DOUBLE PRECISION|1e0/);

      for (const temperature of ['FIRST', 'REPEAT']) {
        const cursor = endpoint.sourceRequests.length;
        const started = performance.now();
        const actual = await endpoint.execute(fixture.query, 'analyst');
        const requests = endpoint.sourceRequests.slice(cursor);
        console.log('MC18 compiler-authored numeric capture', JSON.stringify({
          caseId: fixture.id,
          temperature,
          query: fixture.query,
          sqlSha256: createHash('sha256').update(fixture.sql).digest('hex'),
          fixtureSha256: packet.fixtureSha256,
          emitterSha256: packet.emitterSha256,
          compilerRevision: packet.compilerRevision,
          schema: actual.messages.find(message => message.schema)?.schema,
          rows: actual.rows,
          wallTimeMs: performance.now() - started,
          sourceRequests: requests
        }));
        expect(actual.rows).toEqual(fixture.expectedRows);
        expect(actual.messages.find(message => message.schema)?.schema).toEqual(fixture.fields);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.completed && request.principal === 'analyst')).toBe(true);
        expect(requests.every(request => request.query.includes('tenant') && request.values.includes('A'))).toBe(true);
      }
    }
  );

  // Independent residual kernel probes complement the compiler-authored
  // positive targets. Backend errors prove rejection only, never arithmetic
  // qualification. An outer cast must not recover an overflowing inner value.
  const max = '99999999999999999999999999999999999999';
  const cast = (value: string, precision = 38, scale = 0) => `CAST('${value}' AS DECIMAL(${precision},${scale}))`;
  const maxMinusOne = '99999999999999999999999999999999999998';
  const overflows: Array<{ id: string; expression: string; controlExpression: string; controlExpected: string }> = [
    {
      id: 'declared-positive',
      expression: `${cast('999999999.999999999', 18, 9)} + ${cast('0.000000001', 18, 9)}`,
      controlExpression: `${cast('999999999.999999998', 18, 9)} + ${cast('0.000000001', 18, 9)}`,
      controlExpected: '999999999.999999999'
    },
    {
      id: 'declared-negative',
      expression: `${cast('-999999999.999999999', 18, 9)} - ${cast('0.000000001', 18, 9)}`,
      controlExpression: `${cast('-999999999.999999998', 18, 9)} - ${cast('0.000000001', 18, 9)}`,
      controlExpected: '-999999999.999999999'
    },
    {
      id: 'capacity-positive-add',
      expression: `${cast(max)} + ${cast(max)}`,
      controlExpression: `${cast(max)} + ${cast('-1')}`,
      controlExpected: maxMinusOne
    },
    {
      id: 'capacity-negative-add',
      expression: `${cast(`-${max}`)} + ${cast(`-${max}`)}`,
      controlExpression: `${cast(`-${max}`)} + ${cast('1')}`,
      controlExpected: `-${maxMinusOne}`
    },
    {
      id: 'capacity-positive-subtract',
      expression: `${cast(max)} - ${cast(`-${max}`)}`,
      controlExpression: `${cast(max)} - ${cast('1')}`,
      controlExpected: maxMinusOne
    },
    {
      id: 'capacity-negative-subtract',
      expression: `${cast(`-${max}`)} - ${cast(max)}`,
      controlExpression: `${cast(`-${max}`)} - ${cast('-1')}`,
      controlExpected: `-${maxMinusOne}`
    },
  ];
  test.each(overflows)('$id refuses true residual decimal overflow and keeps the endpoint usable', async fixture => {
    for (const temperature of ['FIRST', 'REPEAT']) {
      const scale = fixture.id.startsWith('declared') ? 9 : 0;
      const controlQuery = `SELECT CAST((${fixture.controlExpression}) AS DECIMAL(38,${scale})) AS control LIMIT 10`;
      const controlCursor = endpoint.sourceRequests.length;
      const controlStarted = performance.now();
      const control = await endpoint.execute(controlQuery, 'analyst');
      const controlSchema = control.messages.find(message => message.schema)?.schema;
      const controlRows: Array<Array<string | null>> = [[fixture.controlExpected]];
      const expectedControlSchema: Array<{ name: string; column_type: string }> = [{ name: 'control', column_type: `Decimal(38, ${scale})` }];
      expect(control.rows).toEqual(controlRows);
      expect(controlSchema).toEqual(expectedControlSchema);
      expect(endpoint.sourceRequests.slice(controlCursor)).toHaveLength(0);
      const controlEvidence = {
        query: controlQuery,
        rows: control.rows,
        schema: controlSchema,
        wallTimeMs: performance.now() - controlStarted,
        sourceRequests: []
      };
      const query = `SELECT CAST((${fixture.expression}) AS DECIMAL(38,${scale})) AS overflow LIMIT 10`;
      const cursor = endpoint.sourceRequests.length;
      const started = performance.now();
      let failure: Error | undefined;

      try {
        const accepted = await endpoint.execute(query, 'analyst');
        console.log('MC18 decimal overflow incorrectly accepted', JSON.stringify({ caseId: fixture.id, temperature, query, rows: accepted.rows, schema: accepted.messages.find(message => message.schema)?.schema }));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/overflow|capacity|precision|out of range/i);
      expect(endpoint.sourceRequests.slice(cursor)).toHaveLength(0);
      console.log('MC18 residual decimal overflow rejection', JSON.stringify({
        caseId: fixture.id,
        temperature,
        query,
        error: failure!.message,
        control: controlEvidence,
        wallTimeMs: performance.now() - started,
        sourceRequests: [],
        evidenceBoundary: 'Native residual rejection; does not qualify successful compiler arithmetic or source pushdown.'
      }));
      const usable = await endpoint.execute("SELECT CAST('0' AS DECIMAL(38,9)) AS usable LIMIT 10", 'analyst');
      expect(usable.rows).toEqual([['0.000000000']]);
      expect(usable.messages.find(message => message.schema)?.schema).toEqual([{ name: 'usable', column_type: 'Decimal(38, 9)' }]);
      expect(endpoint.sourceRequests.slice(cursor)).toHaveLength(0);
    }
  });
});
