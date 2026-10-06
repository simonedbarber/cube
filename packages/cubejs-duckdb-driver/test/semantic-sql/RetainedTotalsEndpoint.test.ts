import canonicalPacket from './fixtures/retained-totals-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const cube = 'analytics_retained_totals';
const region = `${cube}.region`;
const measureNames = ['total', 'count', 'minimum', 'maximum'];
type Tuple = Array<string | number | null>;
type Fixture = {
  id: string;
  detail: string;
  total: string;
  oracleSql: string;
  groupKeys: string[];
  expectedDetail: Tuple[];
  expectedTotal: Tuple[];
  large: boolean;
  expectedBaseGroups: number;
};
const packet = canonicalPacket as {
  configuredK: number;
  population: number;
  modelSource: string;
  setupSQL: string;
  cases: Fixture[];
};

/** Frozen current QueryRails retained producer through actual semantic HTTP and
 * source execution. Numerical source evidence does not establish public
 * population admission, application scope/cache authority or lifecycle. */
describe('Retained native measure totals through the SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode: true,
      grants: new Map([['auditor', ['auditor']]]),
    });
    const source = await (await endpoint.connection.run(`SELECT COUNT(DISTINCT region) AS groups
      FROM ${cube} WHERE id > 0 AND channel = 'keep'`)).getRowObjects();
    expect(Number(source[0].groups)).toBe(packet.population);
    expect(packet.population).toBeGreaterThan(packet.configuredK);
  });
  afterAll(async () => { await endpoint?.stop(); });

  function tuples(result: Awaited<ReturnType<typeof endpoint.execute>>, grouped: boolean) {
    const names = [...(grouped ? [region] : []), ...measureNames.map(name => `${cube}.${name}`)];
    expect(result.messages.find(message => message.schema)?.schema).toEqual(names.map(name => {
      let columnType = 'Double';
      if (name === region) columnType = 'String';
      else if (name === `${cube}.count`) columnType = 'Int64';
      return { name, column_type: columnType };
    }));
    return result.rows.map(row => row.map((value, index) => {
      if (grouped && index === 0) return value;
      if (value === null) return null;
      expect(typeof value).toBe('string');
      const number = Number(value);
      expect(Number.isFinite(number)).toBe(true);
      return number;
    })) as Tuple[];
  }

  test.each(packet.cases)('$id preserves independent complete retained totals', async fixture => {
    const oracle = await (await endpoint.connection.run(fixture.oracleSql)).getRowObjects();
    expect(oracle.map(row => [
      ...(fixture.groupKeys.length ? [row.region] : []),
      ...measureNames.map(name => (row[name] === null ? null : Number(row[name]))),
    ])).toEqual(fixture.expectedTotal);
    const start = endpoint.sourceRequests.length;
    const detail = tuples(await endpoint.execute(fixture.detail, 'auditor'), true);
    expect(detail).toEqual(fixture.expectedDetail);
    const totalStart = endpoint.sourceRequests.length;
    const total = tuples(await endpoint.execute(fixture.total, 'auditor'), fixture.groupKeys.length > 0);
    if (fixture.groupKeys.length) total.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(total).toEqual(fixture.expectedTotal);
    const issued = endpoint.sourceRequests.slice(start);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(request => request.principal === 'auditor' && request.completed)).toBe(true);
    expect(issued.every(request => request.query.includes("channel = 'keep'"))).toBe(true);
    const detailRequests = endpoint.sourceRequests.slice(start, totalStart);
    expect(detailRequests).toHaveLength(1);
    expect(detailRequests[0].streamed).toBe(false);
    expect(detailRequests[0].query).toMatch(/LIMIT 1/);
    expect(detailRequests[0].rowCount).toBe(fixture.expectedDetail.length);
    const totalRequests = endpoint.sourceRequests.slice(totalStart);
    expect(totalRequests).toHaveLength(1);
    expect(totalRequests[0].streamed).toBe(true);
    expect(totalRequests[0].query).not.toMatch(/\b(?:LIMIT|OFFSET)\b/i);
    expect(totalRequests[0].rowCount).toBe(fixture.expectedBaseGroups);
    console.log('canonical retained total source capture', JSON.stringify({
      caseId: fixture.id,
      configuredK: packet.configuredK,
      population: fixture.large ? packet.population : 2,
      sourceRequests: issued,
      detail,
      total,
    }));
  });
});
