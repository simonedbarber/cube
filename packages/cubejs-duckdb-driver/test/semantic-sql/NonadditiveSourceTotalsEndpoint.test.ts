import canonicalPacket from './fixtures/nonadditive-source-totals-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const region = 'analytics_nonadditive_totals.region';
const sourceNames = ['average', 'samples', 'distinct', 'total', 'weighted_native', 'weighted'];
type Tuple = Array<string | number | null>;
type Fixture = {
  id: string;
  detail: string;
  total: string;
  oracleSql: string;
  detailOracleSql: string;
  groupKeys: string[];
  expectedDetail: Tuple[];
  expectedTotal: Tuple[];
  large: boolean;
  sourcePopulationSql: string;
  expectedSourceRows: number;
};
const packet = canonicalPacket as {
  configuredK: number;
  population: number;
  modelSource: string;
  setupSQL: string;
  outputs: string[];
  cases: Fixture[];
  finalizedGroupControl: { query: string; expected: Tuple[]; sourceExpected: Tuple[] };
};

/** Frozen current public source-total owner through actual native HTTP/source
 * execution. These fixtures do not establish application authority/cache,
 * retained-state eligibility or native process/resource lifecycle. */
describe('Non-additive source totals through the SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['auditor', ['auditor']]]),
    });
    const source = await (await endpoint.connection.run(`SELECT COUNT(*) AS rows
      FROM analytics_nonadditive_totals WHERE id > 0 AND channel = 'keep'`)).getRowObjects();
    expect(Number(source[0].rows)).toBe(packet.population);
    expect(packet.population).toBeGreaterThan(packet.configuredK);
  });
  afterAll(async () => { await endpoint?.stop(); });

  function tuples(result: Awaited<ReturnType<typeof endpoint.execute>>, grouped: boolean) {
    const fields = [
      ...(grouped ? [{ name: region, column_type: 'String' }] : []),
      ...packet.outputs.map((name, index) => ({ name, column_type: index === 1 || index === 2 ? 'Int64' : 'Double' })),
    ];
    expect(result.messages.find(message => message.schema)?.schema).toEqual(fields);
    return result.rows.map(row => row.map((value, index) => {
      if (grouped && index === 0) return value;
      if (value === null) return null;
      expect(typeof value).toBe('string');
      const number = Number(value);
      expect(Number.isFinite(number)).toBe(true);
      return number;
    })) as Tuple[];
  }

  function oracleTuples(rows: Record<string, unknown>[], grouped: boolean): Tuple[] {
    return rows.map(row => [
      ...(grouped ? [row.region as string] : []),
      ...sourceNames.map(name => (row[name] == null ? null : Number(row[name]))),
    ]);
  }

  test.each(packet.cases)('$id recomputes non-additive totals from their source owner', async fixture => {
    const population = await (await endpoint.connection.run(fixture.sourcePopulationSql)).getRowObjects();
    expect(Number(population[0].rows)).toBe(fixture.expectedSourceRows);
    const oracle = await (await endpoint.connection.run(fixture.oracleSql)).getRowObjects();
    expect(oracleTuples(oracle, fixture.groupKeys.length > 0)).toEqual(fixture.expectedTotal);
    const detailOracle = await (await endpoint.connection.run(fixture.detailOracleSql)).getRowObjects();
    expect(oracleTuples(detailOracle, true)).toEqual(fixture.expectedDetail);
    const start = endpoint.sourceRequests.length;
    const detail = tuples(await endpoint.execute(fixture.detail, 'auditor'), true);
    expect(detail).toEqual(fixture.expectedDetail);
    const total = tuples(await endpoint.execute(fixture.total, 'auditor'), fixture.groupKeys.length > 0);
    if (fixture.groupKeys.length) total.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(total).toEqual(fixture.expectedTotal);
    const issued = endpoint.sourceRequests.slice(start);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(request => request.principal === 'auditor' && request.completed)).toBe(true);
    expect(issued.every(request => request.query.includes("channel = 'keep'"))).toBe(true);
    console.log('canonical non-additive source total capture', JSON.stringify({
      caseId: fixture.id,
      configuredK: packet.configuredK,
      sourcePopulation: fixture.expectedSourceRows,
      sourceRequests: issued,
      detail,
      total,
    }));
  });

  test('finalized group mean and distinct sum differ from source truth', async () => {
    const result = await endpoint.execute(packet.finalizedGroupControl.query, 'auditor');
    expect(result.messages.find(message => message.schema)?.schema).toEqual([
      { name: 'wrong_average', column_type: 'Double' },
      { name: 'wrong_distinct', column_type: 'Int64' },
    ]);
    const values = result.rows.map(row => row.map(value => Number(value)));
    expect(values).toEqual(packet.finalizedGroupControl.expected);
    expect(values).not.toEqual(packet.finalizedGroupControl.sourceExpected);
  });
});
