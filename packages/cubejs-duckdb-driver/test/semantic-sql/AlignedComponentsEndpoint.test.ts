import canonicalPacket from './fixtures/aligned-component-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

type Tuple = Array<string | number | null>;
type CanonicalCase = { id: string;
  query: string;
  configuredK: number;
  expected: Tuple[];
  population?: number;
  baseGroups?: number;
  componentGroups?: number;
  alignedGroups?: number };
const packet = canonicalPacket as { cases: CanonicalCase[] };
const model = `cube('analytics_key_domain', {
  sql: 'SELECT * FROM analytics_key_domain WHERE id <> -8',
  dimensions: {
    id: { sql: 'id', type: 'number', primary_key: true, public: true },
    region: { sql: 'region', type: 'string' }, created_at: { sql: 'created_at', type: 'time' },
    status: { sql: 'status', type: 'string' }, amount: { sql: 'amount', type: 'number' }
  }
});`;

/** Frozen canonical emitter bytes through native HTTP and actual source SQL.
 * The numerical packet preserves the original captured K and never substitutes
 * a refusal for expected rows. This is supplemental source qualification, not
 * released-runtime, application-authority or source-cache qualification. */
describe('Aligned component keys through the native SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    const large = packet.cases.find(fixture => fixture.population !== undefined);
    if (!large?.population) throw new Error('Missing canonical complete-input population');
    endpoint = await startSemanticSqlEndpoint({
      model: () => model,
      streamMode: true,
      grants: new Map([['auditor', ['auditor']]]),
      setupSQL: `CREATE TABLE analytics_key_domain(id INTEGER PRIMARY KEY, region VARCHAR, status VARCHAR, amount DOUBLE, created_at TIMESTAMPTZ);
        INSERT INTO analytics_key_domain VALUES
        (-1,'A','current',10,'2024-03-01 00:00:00+00'),(-2,'A','current',20,'2024-03-02 00:00:00+00'),(-3,'A','current',13,'2024-04-01 00:00:00+00'),
        (-4,'B','other',40,'2024-03-01 00:00:00+00'),(-5,'B','other',41,'2024-04-01 00:00:00+00'),(-6,NULL,'current',5,'2024-03-01 00:00:00+00'),
        (-7,NULL,'other',7,'2024-03-01 00:00:00+00'),(-8,NULL,'other',9000,'2024-03-01 00:00:00+00'),(-9,'history-only','other',999,'2024-01-01 00:00:00+00'),
        (-10,'C','third',8,'2024-03-01 00:00:00+00'),(-11,'A','third',11,'2024-04-01 00:00:00+00');
        INSERT INTO analytics_key_domain SELECT id, LPAD(id::VARCHAR, 8, '0'),
          CASE WHEN id % 2 = 0 THEN 'current' ELSE 'other' END, CASE WHEN id % 2 = 0 THEN id ELSE id * 10 END,
          TIMESTAMPTZ '2025-03-01 00:00:00+00' FROM generate_series(1, ${large.population}) AS input(id);`,
    });
    const counts = await (await endpoint.connection.run(`SELECT status, COUNT(*) AS groups FROM analytics_key_domain
      WHERE id > 0 GROUP BY status ORDER BY status`)).getRowObjects();
    expect(counts.map(row => [row.status, Number(row.groups)])).toEqual([['current', large.baseGroups], ['other', large.componentGroups]]);
    expect(large.baseGroups).toBeGreaterThan(large.configuredK);
    expect(large.componentGroups).toBeGreaterThan(large.configuredK);
    expect(large.alignedGroups).toBe(large.population);
  });
  afterAll(async () => { await endpoint?.stop(); });

  test.each(packet.cases)('$id preserves canonical keys, NULL values and complete component populations', async fixture => {
    const start = endpoint.sourceRequests.length;
    const result = await endpoint.execute(fixture.query, 'auditor');
    console.log('canonical aligned endpoint transport', JSON.stringify({ caseId: fixture.id,
      rawRows: result.rows,
      sourceRequests: endpoint.sourceRequests.slice(start).map(request => ({
        streamed: request.streamed,
        rowCount: request.rowCount,
        completed: request.completed,
        hasSourceLimit: /\bLIMIT\s+\d+/i.test(request.query),
      })) }));
    const schema = result.messages.find(message => message.schema)?.schema;
    expect(schema).toEqual([
      { name: 'analytics_key_domain.region', column_type: 'String' },
      { name: 'analytics_key_domain.created_at', column_type: 'Timestamp' },
      ...['amount', 'other', 'third', 'combined'].map(name => ({ name, column_type: 'Double' })),
    ]);
    const rows = result.rows.map(row => {
      // Native Timestamp cells are unzoned wall-clock strings in the query
      // timezone (UTC here). Validate that transport contract before decoding;
      // implicit Date parsing would instead use the host session timezone.
      expect(row[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
      return [row[0], new Date(`${row[1]}Z`).toISOString().slice(0, 7),
        ...row.slice(2).map(value => (value === null ? null : Number(value)))];
    });
    expect(rows).toEqual(fixture.expected);
    const issued = endpoint.sourceRequests.slice(start);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(query => query.principal === 'auditor')).toBe(true);
    expect(issued.some(query => query.query.includes('id <> -8'))).toBe(true);
    expect(issued.every(query => query.streamed && query.completed)).toBe(true);
    if (fixture.population !== undefined) {
      expect(issued.map(query => query.rowCount).sort((a, b) => a - b)).toEqual(
        [0, fixture.baseGroups, fixture.componentGroups, fixture.alignedGroups].sort((a, b) => a! - b!)
      );
      expect(issued.every(query => !/\bLIMIT\s+\d+/i.test(query.query))).toBe(true);
    }
    console.log('canonical aligned endpoint source capture', JSON.stringify({ caseId: fixture.id,
      configuredK: fixture.configuredK,
      sourceRequests: issued,
      rows }));
  });
});
