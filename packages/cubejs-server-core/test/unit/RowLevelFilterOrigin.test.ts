import type { NormalizedQuery } from '@cubejs-backend/api-gateway';
import { CompilerApi } from '../../src/core/CompilerApi';

const cubeNames = ['Orders', 'Customers'];
const policy = (cube: string, values = ['A']) => ({
  rowLevel: { filters: [{ memberReference: `${cube}.region`, operator: 'equals', values: () => values }] },
});
const condition = (cube: string, values = ['A']) => ({ member: `${cube}.region`, operator: 'equals' as const, values });

function fixture(members = ['Orders.id', 'Customers.label']) {
  // Exercise the actual policy combiner without invoking unrelated model
  // compilation. Evaluator facts and current applicable policies are inputs.
  const api = Object.create(CompilerApi.prototype) as CompilerApi;
  const cubes = Object.fromEntries(cubeNames.map(name => [name, { name, isView: false }]));
  const cubeEvaluator = {
    isRbacEnabled: jest.fn(() => true),
    isRbacEnabledForCube: () => true,
    cubeFromPath: (name: string) => cubes[name],
    evaluateContextFunction: (_cube: unknown, value: () => unknown) => value(),
  };
  api.getCompilers = jest.fn(async () => ({ cubeEvaluator })) as any;
  api.getSql = jest.fn(async () => ({ memberNames: members })) as any;
  const policies = new Map(cubeNames.map(name => [name, [policy(name)]]));
  const applicable = jest.spyOn(api as any, 'getApplicablePolicies').mockImplementation(async (cube: any) => policies.get(cube.name));
  const query: NormalizedQuery = {
    measures: [], dimensions: members, filters: [{ member: 'Orders.status', operator: 'equals', values: ['paid'] }],
  };
  const context: any = { requestId: 'policy-origin-fixture', securityContext: {} };
  return { api, query, context, policies, applicable, cubeEvaluator, cubes };
}

describe('Current row-level policy origin', () => {
  test('keeps distinct protected input facts and the existing global constraint', async () => {
    const { api, query, context } = fixture();
    const result = await api.applyRowLevelSecurity(query, query, context);
    expect(result.denied).toBe(false);
    expect(result.query.rowLevelFilters).toEqual(cubeNames.map(cube => ({ cube, filter: condition(cube) })));
    expect(result.query.filters).toEqual([
      { member: 'Orders.status', operator: 'equals', values: ['paid'] },
      { and: cubeNames.map(cube => condition(cube)) },
    ]);
  });

  test('preserves OR across granting policies within each protected population', async () => {
    const { api, query, context, policies } = fixture();
    policies.set('Customers', [policy('Customers'), policy('Customers', ['B'])]);
    await api.applyRowLevelSecurity(query, query, context);
    expect(query.rowLevelFilters).toEqual([
      { cube: 'Orders', filter: condition('Orders') },
      { cube: 'Customers', filter: { or: [condition('Customers'), condition('Customers', ['B'])] } },
    ]);
  });

  test('retains member-level intersection instead of broadening disjoint policies', async () => {
    const { api, query, context, applicable } = fixture(['Orders.id', 'Customers.label', 'Customers.region']);
    applicable.mockImplementation(async (cube: any) => (cube.name === 'Orders' ? [policy('Orders')] : [
      { ...policy('Customers'), memberLevel: { includesMembers: ['Customers.label'], excludesMembers: [] } },
      { ...policy('Customers', ['B']), memberLevel: { includesMembers: ['Customers.region'], excludesMembers: [] } },
    ]));
    await api.applyRowLevelSecurity(query, query, context);
    expect(query.rowLevelFilters![1]).toEqual({ cube: 'Customers', filter: { and: [condition('Customers'), condition('Customers', ['B'])] } });
  });

  test('unrestricted policies produce no protected restriction for that input', async () => {
    const { api, query, context, applicable } = fixture();
    applicable.mockImplementation(async (cube: any) => (cube.name === 'Customers' ? [{ rowLevel: { allowAll: true } }] : [policy('Orders')]));
    await api.applyRowLevelSecurity(query, query, context);
    expect(query.rowLevelFilters).toEqual([{ cube: 'Orders', filter: condition('Orders') }]);
  });

  test('keeps view and underlying cube origins distinct', async () => {
    const { api, query, context, cubes, applicable } = fixture(['Orders.id', 'Customers.label', 'CustomerView.label']);
    cubes.CustomerView = { name: 'CustomerView', isView: true, includedMembers: [{ memberPath: 'Customers.label' }] } as any;
    applicable.mockImplementation(async (cube: any) => [policy(cube.name)]);
    await api.applyRowLevelSecurity(query, query, context);
    expect(query.rowLevelFilters?.map(item => item.cube)).toEqual(['Orders', 'Customers', 'CustomerView']);
  });

  test('denied membership never mints a partial protected population', async () => {
    const { api, query, context, applicable } = fixture();
    applicable.mockResolvedValue([]);
    const result = await api.applyRowLevelSecurity(query, query, context);
    expect(result.denied).toBe(true);
    expect(query.rowLevelFilters).toBeUndefined();
    expect(query.segments).toMatchObject([{ cubeName: 'Orders', name: 'rlsAccessDenied' }]);
  });

  test('disabled policy resolution discards carried origin facts', async () => {
    const { api, query, context, cubeEvaluator } = fixture();
    query.rowLevelFilters = [{ cube: 'Customers', filter: condition('Customers', ['stale']) }];
    cubeEvaluator.isRbacEnabled.mockReturnValue(false);
    await api.applyRowLevelSecurity(query, query, context);
    expect(query.rowLevelFilters).toBeUndefined();
  });
});
