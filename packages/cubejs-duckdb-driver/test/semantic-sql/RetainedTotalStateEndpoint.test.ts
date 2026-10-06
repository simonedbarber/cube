import canonicalPacket from './fixtures/retained-total-state-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

type Tuple = Array<string | number | null>;
const packet = canonicalPacket as {
  configuredK: number;
  population: number;
  cube: string;
  modelSource: string;
  setupSQL: string;
  controls: Array<{ id: string; sql: string; expectedWrong: Tuple[]; expectedTotal: Tuple[] }>;
  singleMeasures: Array<{
    id: string;
    sql: string;
    fields: Array<{ name: string; column_type: string }>;
    expected: Tuple[];
    oracleSql: string;
    oracleMember: string;
  }>;
  cases: Array<{
    id: string;
    detail: string;
    total: string;
    oracleSql: string;
    groupKeys: string[];
    expectedDetail: Tuple[];
    expectedTotal: Tuple[];
    expectedBaseGroups: number;
    large: boolean;
  }>;
};

describe('Retained sufficient state through the actual semantic HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['auditor', ['auditor']]]),
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  function tuples(result: Awaited<ReturnType<typeof endpoint.execute>>, grouped: boolean) {
    expect(result.messages.find(message => message.schema)?.schema).toEqual([
      ...(grouped ? [{ name: `${packet.cube}.region`, column_type: 'String' }] : []),
      { name: `${packet.cube}.average`, column_type: 'Double' },
      { name: `${packet.cube}.people`, column_type: 'Int64' },
    ]);
    return result.rows.map(row => row.map((value, index) => {
      if (value === null || (grouped && index === 0)) return value;
      expect(typeof value).toBe('string');
      expect(Number.isFinite(Number(value))).toBe(true);
      return Number(value);
    })) as Tuple[];
  }

  test.each(packet.cases)('$id recomputes the exact retained observation meaning', async fixture => {
    const oracle = await (await endpoint.connection.run(fixture.oracleSql)).getRowObjects();
    expect(oracle.map(row => [...(fixture.groupKeys.length ? [row.region] : []),
      row.average === null ? null : Number(row.average), Number(row.people)])).toEqual(fixture.expectedTotal);
    expect(tuples(await endpoint.execute(fixture.detail, 'auditor'), true)).toEqual(fixture.expectedDetail);
    const start = endpoint.sourceRequests.length;
    const actual = tuples(await endpoint.execute(fixture.total, 'auditor'), fixture.groupKeys.length > 0);
    if (fixture.groupKeys.length) actual.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(actual).toEqual(fixture.expectedTotal);
    const source = endpoint.sourceRequests.slice(start);
    expect(source.length).toBeGreaterThan(0);
    expect(source.every(request => request.principal === 'auditor' && request.completed)).toBe(true);
    expect(source.every(request => request.query.includes("channel = 'keep'"))).toBe(true);
    expect(source.every(request => !/\b(?:LIMIT|OFFSET)\b/i.test(request.query))).toBe(true);
    if (fixture.large) {
      expect(packet.population).toBeGreaterThan(packet.configuredK);
      expect(source.some(request => request.streamed && request.rowCount === packet.population)).toBe(true);
    }
    console.log('canonical retained sufficient-state source capture', JSON.stringify({
      caseId: fixture.id,
      configuredK: packet.configuredK,
      expectedBaseGroups: fixture.expectedBaseGroups,
      sourceRequests: source,
      actual,
    }));
  });

  test.each(packet.controls)('$id fails the unchanged numerical target', async control => {
    const actual = tuples(await endpoint.execute(control.sql, 'auditor'), false);
    expect(actual).toEqual(control.expectedWrong);
    expect(actual).not.toEqual(control.expectedTotal);
    console.log('retained state discriminating composition control', JSON.stringify({
      caseId: control.id,
      actual,
      unchangedExpected: control.expectedTotal,
    }));
  });

  test.each(packet.singleMeasures)('$id preserves its independent aggregate row and type', async fixture => {
    const oracle = await (await endpoint.connection.run(fixture.oracleSql)).getRowObjects();
    expect(oracle.map(row => [row[fixture.oracleMember] === null ? null : Number(row[fixture.oracleMember])])).toEqual(fixture.expected);
    const result = await endpoint.execute(fixture.sql, 'auditor');
    expect(result.messages.find(message => message.schema)?.schema).toEqual(fixture.fields);
    expect(result.rows.map(row => row.map(value => (value === null ? null : Number(value))))).toEqual(fixture.expected);
  });
});
