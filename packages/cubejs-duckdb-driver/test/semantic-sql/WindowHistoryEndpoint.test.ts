import packet from './fixtures/window-history-canonical-sql.json';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

type Tuple = Array<string | number | null>;
const streamMode = process.env.CUBESQL_STREAM_MODE === 'true';
const requestedBufferedK = Number(process.env.CUBESQL_NON_STREAMING_QUERY_MAX_ROW_LIMIT);
const completeBuffered = !streamMode && requestedBufferedK > packet.population;
const largeCases = packet.cases.filter(fixture => fixture.large);
const boundedCases = packet.cases.filter(fixture => !fixture.large);
const selectedCases = streamMode || completeBuffered ? packet.cases : boundedCases;

/** Exact private production lowering; its public capability remains refused.
 * Actual HTTP/native/source types and complete delivery are exercised. The
 * fixture does not qualify application cache/authority, shutdown or resources. */
describe('Absolute input-range history through the SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    // These environment values must reach Rust before the addon is loaded.
    expect(Number.isSafeInteger(requestedBufferedK)).toBe(true);
    expect(requestedBufferedK).toBeGreaterThanOrEqual(4);
    if (process.env.CUBEJS_DB_QUERY_DEFAULT_LIMIT !== undefined) {
      expect(Number(process.env.CUBEJS_DB_QUERY_DEFAULT_LIMIT)).toBe(requestedBufferedK);
    }
    expect(packet.population).toBe(packet.configuredK + 10001);
    endpoint = await startSemanticSqlEndpoint({
      model: () => packet.modelSource,
      setupSQL: packet.setupSQL,
      streamMode,
      grants: new Map([['auditor', ['auditor']], ['analyst', ['analyst']]]),
    });
    const source = await (await endpoint.connection.run('SELECT COUNT(*) AS rows FROM analytics_window_history WHERE id > 0')).getRowObjects();
    expect(Number(source[0].rows)).toBe(packet.population);
  });
  afterAll(async () => { await endpoint?.stop(); });

  function timestamp(value: unknown, large: boolean): string {
    expect(typeof value).toBe('string');
    const text = String(value);
    // Native Timestamp cells are UTC wall-clock values without a zone.
    const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    expect(Number.isFinite(date.getTime())).toBe(true);
    return large ? date.toISOString() : date.toISOString().slice(0, 7);
  }

  async function oracle(fixture: typeof packet.cases[number]): Promise<Tuple[]> {
    const rows = await (await endpoint.connection.run(fixture.oracle)).getRowObjects();
    return rows.map(row => [
      row.region == null ? null : String(row.region),
      fixture.large ? new Date(String(row.bucket)).toISOString() : new Date(String(row.bucket)).toISOString().slice(0, 7),
      row.running == null ? null : Number(row.running),
    ]);
  }

  test.each(selectedCases)('$id preserves history, NULLs and final selection', async fixture => {
    expect(await oracle(fixture)).toEqual(fixture.expected);
    const cursor = endpoint.sourceRequests.length;
    const result = await endpoint.execute(fixture.query, fixture.principal);
    expect(result.messages.find(message => message.schema)?.schema).toEqual([
      { name: packet.region, column_type: 'String' },
      { name: packet.axis, column_type: 'Timestamp' },
      { name: 'running', column_type: 'Double' },
    ]);
    const rows = result.rows.map(row => [
      row[0], timestamp(row[1], fixture.large), row[2] === null ? null : Number(row[2]),
    ]);
    expect(rows).toEqual(fixture.expected);
    const issued = endpoint.sourceRequests.slice(cursor);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(request => request.completed && request.principal === fixture.principal && request.streamed === streamMode)).toBe(true);
    expect(issued.every(request => /id\s*<>\s*-8/.test(request.query))).toBe(true);
    if (fixture.large) {
      expect(Math.max(...issued.map(request => request.rowCount))).toBeGreaterThanOrEqual(packet.population);
      if (streamMode) expect(issued.every(request => !/\bLIMIT\s+\d+\b/i.test(request.query))).toBe(true);
    }
    console.log('canonical extra-history endpoint capture', JSON.stringify({
      caseId: fixture.id,
      configuredK: packet.configuredK,
      requestedBufferedK,
      configuredCubeUpperBound: process.env.CUBEJS_DB_QUERY_LIMIT ?? null,
      completeHistoryGroups: fixture.large ? packet.population : null,
      streamMode,
      sourceRequests: issued,
      schema: result.messages.find(message => message.schema)?.schema,
      rows,
    }));
  });

  (streamMode || completeBuffered ? test.skip : test).each(largeCases)('$id refuses buffered input at its inserted source cap', async fixture => {
    // Refusal is a separate control; it does not pass this numerical target.
    expect(await oracle(fixture)).toEqual(fixture.expected);
    const cursor = endpoint.sourceRequests.length;
    const response = await endpoint.request(fixture.query, fixture.principal);
    const body = await response.text();
    expect(body).toMatch(/maximum row limit/i);
    const messages = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(messages.some(message => message.error)).toBe(true);
    const deliveredRows = messages.flatMap(message => message.data || []);
    expect(deliveredRows).toEqual([]);
    const issued = endpoint.sourceRequests.slice(cursor);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(request => request.principal === fixture.principal && !request.streamed)).toBe(true);
    expect(issued.some(request => request.completed && request.rowCount === requestedBufferedK)).toBe(true);
    console.log('extra-history buffered refusal control', JSON.stringify({
      caseId: fixture.id,
      configuredK: packet.configuredK,
      requestedBufferedK,
      configuredCubeUpperBound: process.env.CUBEJS_DB_QUERY_LIMIT ?? null,
      completeHistoryGroups: packet.population,
      sourceRequests: issued,
      deliveredRows,
      evidenceBoundary: 'Inserted buffered cap rejects incomplete source input; no numerical or public-admission pass.',
    }));
  });
});
