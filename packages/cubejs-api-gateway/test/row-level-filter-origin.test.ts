import { ApiGateway } from '../src/gateway';
import { normalizeQuery } from '../src/query';
import type { NormalizedQuery } from '../src/types/query';
import { AdapterApiMock, DataSourceStorageMock } from './mocks';

const query = { measures: ['Orders.count'], timezone: 'UTC' };

function protectedFilters(result: ReturnType<typeof normalizeQuery>) {
  if (!result.rowLevelFilters?.length) throw new Error('Expected server policy origin');
  return result.rowLevelFilters;
}

describe('Protected policy-origin normalization', () => {
  test('normalizes internal leaves with the same rules as the enforced filter', () => {
    const filter = { and: [{ dimension: 'Orders.id', operator: 'equals', values: [7] },
      { or: [{ member: 'Orders.active', operator: 'equals', values: [true] },
        { member: 'Orders.region', operator: 'equals', values: ['A'] }] }] };
    const result = normalizeQuery({ ...query, filters: [filter], rowLevelFilters: [{ cube: 'Orders', filter }] }, false);
    expect(protectedFilters(result)).toEqual([{ cube: 'Orders', filter: result.filters![0] }]);
    expect(protectedFilters(result)[0].filter).toEqual({ and: [
      { member: 'Orders.id', operator: 'equals', values: ['7'] },
      { or: [{ member: 'Orders.active', operator: 'equals', values: ['true'] },
        { member: 'Orders.region', operator: 'equals', values: ['A'] }] },
    ] });
  });

  test('normalizes protected relative date values independently of authored filters', () => {
    const filter = { member: 'Orders.createdAt', operator: 'inDateRange', values: ['last 7 days'] };
    const result = normalizeQuery({ ...query, filters: [filter], rowLevelFilters: [{ cube: 'Orders', filter }] }, false);
    expect(protectedFilters(result)[0].filter).toEqual(result.filters![0]);
    const protectedFilter = protectedFilters(result)[0].filter;
    if (!('values' in protectedFilter)) throw new Error('Expected a protected date filter');
    expect(protectedFilter.values).toHaveLength(2);
  });

  test('rejects malformed protected conditions through existing filter normalization', () => {
    expect(() => normalizeQuery({ ...query, rowLevelFilters: [{ cube: 'Orders', filter: { member: 'Orders.id', operator: 'invalid', values: ['1'] } }] }, false)).toThrow(/Operator invalid not supported/);
  });

  test.each([{ claim: [] }, { claim: [{ cube: 'Orders', filter: { member: 'Orders.region', operator: 'equals', values: ['forged'] } }] }])(
    'rejects caller policy-origin claims before compiler policy resolution (%j)', async ({ claim: rowLevelFilters }) => {
      const policyResolution = jest.fn(async (normalized: NormalizedQuery) => ({
        query: { ...normalized, rowLevelFilters: undefined }, denied: false,
      }));
      const gateway = new ApiGateway('fixture-secret', async () => ({ applyRowLevelSecurity: policyResolution } as any), async () => new AdapterApiMock() as any, () => undefined, {
        standalone: true, dataSourceStorage: new DataSourceStorageMock(), refreshScheduler: {}, basePath: '/cubejs-api',
      });

      try {
        await expect((gateway as any).getNormalizedQueries({ ...query, rowLevelFilters }, { requestId: 'forged-policy-origin' })).rejects.toThrow('rowLevelFilters cannot be provided in the query');
        expect(policyResolution).not.toHaveBeenCalled();
      } finally {
        gateway.release();
      }
    }
  );

  test('carries current policy origin across a replacement queryRewrite result', async () => {
    const filter = { member: 'Orders.region', operator: 'equals', values: ['A'] };
    const current = [{ cube: 'Orders', filter }];
    const gateway = new ApiGateway('fixture-secret', async () => ({
      applyRowLevelSecurity: async (normalized: any) => ({
        query: { ...normalized, filters: [filter], rowLevelFilters: current }, denied: false,
      }),
    } as any), async () => new AdapterApiMock() as any, () => undefined, {
      standalone: true,
      dataSourceStorage: new DataSourceStorageMock(),
      refreshScheduler: {},
      basePath: '/cubejs-api',
      queryRewrite: async normalized => ({ ...normalized, rowLevelFilters: [{ cube: 'Orders', filter: { ...filter, values: ['forged'] } }] }),
    });

    try {
      const [, normalized] = await (gateway as any).getNormalizedQueries(query, { requestId: 'current-policy-origin' });
      expect(normalized[0].rowLevelFilters).toEqual(current);
      expect(normalized[0].filters).toEqual([filter]);
    } finally {
      gateway.release();
    }
  });
});
