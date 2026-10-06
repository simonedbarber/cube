import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { startSemanticSqlEndpoint } from './SemanticSqlEndpointFixture';

const model = `cube('paired_samples', {
  sql: 'SELECT * FROM paired_samples WHERE included = TRUE',
  access_policy: [{ group: 'reviewer', member_level: { includes: '*' },
    row_level: { filters: [{ member: 'tenant', operator: 'equals', values: ['A'] }] } }],
  dimensions: {
    id: { sql: 'id', type: 'number', primary_key: true, public: true },
    tenant: { sql: 'tenant', type: 'string' }, cohort: { sql: 'cohort', type: 'string' },
    x: { sql: 'x', type: 'number' }, y: { sql: 'y', type: 'number' }
  },
  measures: { paired_population_covariance: { type: 'number_agg', sql: 'COVAR_POP(x, y)' } }
});`;
const setupSQL = `CREATE TABLE paired_samples
  (id BIGINT, tenant VARCHAR, cohort VARCHAR, x DOUBLE, y DOUBLE, included BOOLEAN);
INSERT INTO paired_samples VALUES
  (1, 'A', 'positive', 1, 2, TRUE), (2, 'A', 'positive', 3, 6, TRUE),
  (3, 'A', 'positive', 100, NULL, TRUE), (4, 'A', 'positive', NULL, 200, TRUE),
  (5, 'A', 'negative', 1, 6, TRUE), (6, 'A', 'negative', 3, 2, TRUE),
  (7, 'A', 'singleton', 5, 9, TRUE), (8, 'A', 'singleton', NULL, 8, TRUE),
  (9, 'A', 'empty_pairs', NULL, 8, TRUE), (10, 'A', 'empty_pairs', 4, NULL, TRUE),
  (11, 'A', 'positive', 1000, -1000, FALSE), (12, 'B', 'positive', 9999, -9999, TRUE),
  (13, 'A', 'constant_x', 2, 1, TRUE), (14, 'A', 'constant_x', 2, 3, TRUE),
  (15, 'A', 'constant_x', 100, NULL, TRUE),
  (16, 'A', 'constant_y', 1, 2, TRUE), (17, 'A', 'constant_y', 3, 2, TRUE),
  (18, 'A', 'constant_y', NULL, 100, TRUE);`;

// Independent centered products for x={1,3}, y={2,6} sum to 4 at n=2;
// reversing y negates this. Incomplete pairs never enter the population.
const cases = [
  { function: 'CORR', values: [null, null, null, -1, 1, null] },
  { function: 'COVAR_SAMP', values: [0, 0, null, -4, 4, null] },
  { function: 'COVAR_POP', values: [0, 0, null, -2, 2, 0] },
];
const cohorts = ['constant_x', 'constant_y', 'empty_pairs', 'negative', 'positive', 'singleton'];

describe('Paired aggregates through the native SQL HTTP endpoint', () => {
  jest.setTimeout(60000);
  let endpoint: Awaited<ReturnType<typeof startSemanticSqlEndpoint>>;
  beforeAll(async () => {
    endpoint = await startSemanticSqlEndpoint({
      model: () => model,
      setupSQL,
      streamMode: true,
      grants: new Map([['auditor', ['reviewer']]])
    });
  });
  afterAll(async () => { await endpoint?.stop(); });

  function rows(result: Awaited<ReturnType<typeof endpoint.execute>>) {
    expect(result.messages.find(message => message.schema)?.schema).toEqual([
      { name: 'cohort', column_type: 'String' }, { name: 'value', column_type: 'Double' },
    ]);
    return result.rows.map(([cohort, value]) => {
      expect(typeof cohort).toBe('string');
      if (value === null) return [cohort, null];
      expect(typeof value).toBe('string');
      expect(String(value).trim().length).toBeGreaterThan(0);
      const number = Number(value);
      expect(Number.isFinite(number)).toBe(true);
      return [cohort, number];
    });
  }

  function assertIssued(start: number, sqlFunction: string) {
    const issued = endpoint.sourceRequests.slice(start);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every(request => request.completed && request.principal === 'auditor')).toBe(true);
    expect(issued.every(request => request.query.includes('included = TRUE') &&
      request.query.includes('tenant') && request.values.includes('A'))).toBe(true);
    expect(issued.some(request => request.query.toUpperCase().includes(`${sqlFunction}(`))).toBe(true);
    return issued;
  }

  it.each(cases)('$function preserves paired populations and source policies on first/repeat runs', async fixture => {
    const query = `SELECT paired_samples.cohort AS cohort,
      ${fixture.function}(paired_samples.x, paired_samples.y) AS value
      FROM paired_samples GROUP BY paired_samples.cohort ORDER BY paired_samples.cohort`;
    const compiled = await endpoint.compileSourceSql(query, 'auditor');
    if ('error' in compiled) throw new Error(`Source compilation failed: ${compiled.error}`);
    // The current declaration exposes a string, while the native response may
    // carry [SQL, parameters]. Validate the observed response without changing
    // that shared contract just for this regression.
    const emitted: unknown = compiled.sql;
    let sourceSql: string | undefined;
    if (typeof emitted === 'string') {
      sourceSql = emitted;
    } else if (Array.isArray(emitted) && typeof emitted[0] === 'string') {
      [sourceSql] = emitted;
    }
    expect(typeof sourceSql).toBe('string');
    if (fixture.function === 'CORR') {
      expect(sourceSql).toContain('REGR_SXX(');
      expect(sourceSql).toContain('REGR_SYY(');
      expect(sourceSql).toContain('ISFINITE(');
    }

    for (const temperature of ['first', 'repeat']) {
      const start = endpoint.sourceRequests.length;
      const actual = rows(await endpoint.execute(query, 'auditor'));
      expect(actual).toEqual(cohorts.map((cohort, index) => [cohort, fixture.values[index]]));
      console.log('paired aggregate capture', JSON.stringify({
        function: fixture.function,
        temperature,
        rows: actual,
        sourceRequests: assertIssued(start, fixture.function)
      }));
    }
  });

  it('executes ordinary number_agg without multi_stage', async () => {
    const query = `SELECT paired_samples.cohort AS cohort,
      MEASURE(paired_samples.paired_population_covariance) AS value
      FROM paired_samples GROUP BY paired_samples.cohort ORDER BY paired_samples.cohort`;
    const start = endpoint.sourceRequests.length;
    expect(rows(await endpoint.execute(query, 'auditor')))
      .toEqual(cohorts.map((cohort, index) => [cohort, cases[2].values[index]]));
    assertIssued(start, 'COVAR_POP');
  });

  it('retains a typed NULL for no contributing rows', async () => {
    const start = endpoint.sourceRequests.length;
    const actual = await endpoint.execute(`SELECT CORR(paired_samples.x, paired_samples.y) AS value
      FROM paired_samples WHERE paired_samples.cohort = 'absent'`, 'auditor');
    expect(actual.messages.find(message => message.schema)?.schema)
      .toEqual([{ name: 'value', column_type: 'Double' }]);
    expect(actual.rows).toEqual([[null]]);
    assertIssued(start, 'CORR');
  });

  it('denies a revoked fixture principal before source dispatch', async () => {
    const start = endpoint.sourceRequests.length;
    const response = await endpoint.request('SELECT CORR(paired_samples.x, paired_samples.y) FROM paired_samples', 'revoked');
    expect(response.status).toBe(403);
    await response.text();
    expect(endpoint.sourceRequests.length).toBe(start);
  });
});
