import R from 'ramda';
import Graph from 'node-dijkstra';
import { getEnv } from '@cubejs-backend/shared';
import { UserError } from './UserError';

import type { CubeValidator } from './CubeValidator';
import type { CubeEvaluator, MeasureDefinition } from './CubeEvaluator';
import type { CubeDefinition, JoinDefinition } from './CubeSymbols';
import type { ErrorReporter } from './ErrorReporter';
import { CompilerInterface } from './PrepareCompiler';

export type JoinEdge = {
  join: JoinDefinition,
  from: string,
  to: string,
  originalFrom: string,
  originalTo: string,
  // Cube whose `joins:` block declared the underlying join. Used to resolve `${CUBE}`
  // references inside `join.sql` so synthetic reverse edges still emit correct SQL.
  // For declared edges this equals `originalFrom`; for synthetic reverse edges it
  // equals the original declaring cube (the new `originalTo`).
  declaredOn: string,
  // True when this edge was synthesized at query time by reversing a declared edge
  // (because the user requested the reverse direction via `__cubeExplicitJoinField`
  // or a directional `join_path` that the model only declared in the opposite
  // direction). On such edges, `join.relationship` is the inverted normalized value
  // (`hasMany ↔ belongsTo`; `hasOne` unchanged) so multiplication semantics are
  // correct.
  synthetic?: boolean,
};

type JoinTreeJoins = JoinEdge[];

type JoinTree = {
  root: string,
  joins: JoinTreeJoins,
};

export type FinishedJoinTree = JoinTree & {
  multiplicationFactor: Record<string, boolean>,
};

// Sentinel marker that cubesql's egraph prepends to a `joinHints` entry when
// the JOIN clause used `__cubeExplicitJoinField`. The marker rides through
// `V1LoadRequestQuery.joinHints` so SQL clause order is preserved end-to-end
// (splitting explicit hints into a separate field loses the interleaving with
// regular `__cubeJoinField` hints). BaseQuery converts sentinel-prefixed entries
// to `ExplicitJoinHint` at the same array position. Must match
// `EXPLICIT_JOIN_HINT_SENTINEL` in `rust/cubesql/cubesql/src/compile/rewrite/rules/members.rs`.
export const EXPLICIT_JOIN_HINT_SENTINEL = '__cubeExplicitJoinField__sentinel__';

// A path-array hint with the `explicit: true` marker, produced ONLY by:
//   1. The cubesql egraph rewrite for `__cubeExplicitJoinField`.
//   2. View `join_path` enrichment in `BaseQuery.enrichHintsWithJoinMap` when the
//      `CUBEJS_BIDIRECTIONAL_SQL_JOINS` feature flag is enabled.
// Explicit hints are the only path that may trigger reverse-edge synthesis. All
// other hint producers continue to emit plain `string | string[]` shapes and get
// the strict directed traversal that matches pre-feature behavior.
export type ExplicitJoinHint = { path: string[], explicit: true };

export type JoinHint = string | string[] | ExplicitJoinHint;

export type JoinHints = JoinHint[];

export function isExplicitJoinHint(hint: JoinHint): hint is ExplicitJoinHint {
  return typeof hint === 'object' && !Array.isArray(hint) && (hint as ExplicitJoinHint).explicit === true;
}

// Accessor used in BaseQuery to flatten join hints into a Set of cube names without
// peeking at the internal representation.
export function joinHintPath(hint: JoinHint): string[] {
  if (typeof hint === 'string') {
    return [hint];
  }
  if (Array.isArray(hint)) {
    return hint;
  }
  return hint.path;
}

// Gate for the bidirectional joins feature. The feature is off by default and is
// enabled with a single env var:
//   - CUBEJS_BIDIRECTIONAL_SQL_JOINS=true
// No dependency on `CUBEJS_TESSERACT_SQL_PLANNER` or `CUBESQL_SQL_PUSH_DOWN` —
// the feature works in both the JS pipeline (REST, GraphQL, view `join_path`,
// the legacy `BaseQuery` SQL generator) and the Tesseract pipeline. All other
// graph traversals stay on the strictly directed graph regardless of this flag
// (no synthetic edges leak into /meta, connectedness, member resolution, REST
// joinHints, pre-aggregation matching, etc.).
function bidirectionalJoinsEnabled(): boolean {
  return getEnv('bidirectionalSqlJoins');
}

export class JoinGraph implements CompilerInterface {
  private readonly cubeValidator: CubeValidator;

  private readonly cubeEvaluator: CubeEvaluator;

  // source node -> destination node -> weight
  private nodes: Record<string, Record<string, 1>>;

  // source node -> destination node -> weight
  private undirectedNodes: Record<string, Record<string, 1>>;

  private edges: Record<string, JoinEdge>;

  private builtJoins: Record<string, FinishedJoinTree>;

  private graph: Graph | null;

  private cachedConnectedComponents: Record<string, number> | null;

  public constructor(cubeValidator: CubeValidator, cubeEvaluator: CubeEvaluator) {
    this.cubeValidator = cubeValidator;
    this.cubeEvaluator = cubeEvaluator;
    this.nodes = {};
    this.undirectedNodes = {};
    this.edges = {};
    this.builtJoins = {};
    this.cachedConnectedComponents = null;
    this.graph = null;
  }

  public compile(cubes: unknown, errorReporter: ErrorReporter): void {
    this.edges = R.compose<
        Array<CubeDefinition>,
        Array<CubeDefinition>,
        Array<[string, JoinEdge][]>,
        Array<[string, JoinEdge]>,
        Record<string, JoinEdge>
    >(
      R.fromPairs,
      R.unnest,
      R.map((v: CubeDefinition): [string, JoinEdge][] => this.buildJoinEdges(v, errorReporter.inContext(`${v.name} cube`))),
      R.filter(this.cubeValidator.isCubeValid.bind(this.cubeValidator))
    )(this.cubeEvaluator.cubeList);

    // This requires @types/ramda@0.29 or newer
    // @ts-ignore
    this.nodes = R.compose<
        Record<string, JoinEdge>,
        Array<[string, JoinEdge]>,
        Array<JoinEdge>,
        Record<string, Array<JoinEdge> | undefined>,
        Record<string, Record<string, 1>>
    >(
      // This requires @types/ramda@0.29 or newer
      // @ts-ignore
      R.map(groupedByFrom => R.fromPairs(groupedByFrom.map(join => [join.to, 1]))),
      R.groupBy((join: JoinEdge) => join.from),
      R.map(v => v[1]),
      R.toPairs
    // @ts-ignore
    )(this.edges);

    // @ts-ignore
    this.undirectedNodes = R.compose(
      // @ts-ignore
      R.map(groupedByFrom => R.fromPairs(groupedByFrom.map(join => [join.from, 1]))),
      // @ts-ignore
      R.groupBy(join => join.to),
      R.unnest,
      // @ts-ignore
      R.map(v => [v[1], { from: v[1].to, to: v[1].from }]),
      R.toPairs
    // @ts-ignore
    )(this.edges);

    this.graph = new Graph(this.nodes);
  }

  protected buildJoinEdges(cube: CubeDefinition, errorReporter: ErrorReporter): Array<[string, JoinEdge]> {
    if (!cube.joins) {
      return [];
    }

    const getMultipliedMeasures = (cubeName: string): MeasureDefinition[] => {
      const measures = this.cubeEvaluator.measuresForCube(cubeName);
      return Object.values(measures).filter((m: MeasureDefinition) => (m.sql &&
          this.cubeEvaluator.funcArguments(m.sql).length === 0 &&
          m.sql() === 'count(*)') ||
        ['sum', 'avg', 'count', 'number'].includes(m.type));
    };

    const joinRequired =
      (v) => `primary key for '${v}' is required when join is defined in order to make aggregates work properly`;

    return cube.joins
      .filter(join => {
        if (!this.cubeEvaluator.cubeExists(join.name)) {
          errorReporter.error(`Cube ${join.name} doesn't exist`);
          return false;
        }

        const fromMultipliedMeasures = getMultipliedMeasures(cube.name);
        if (!this.cubeEvaluator.primaryKeys[cube.name].length && fromMultipliedMeasures.length > 0) {
          errorReporter.error(joinRequired(cube.name));
          return false;
        }

        const toMultipliedMeasures = getMultipliedMeasures(join.name);
        if (!this.cubeEvaluator.primaryKeys[join.name].length && toMultipliedMeasures.length > 0) {
          errorReporter.error(joinRequired(join.name));
          return false;
        }

        return true;
      })
      .map(join => {
        const joinEdge: JoinEdge = {
          join,
          from: cube.name,
          to: join.name,
          originalFrom: cube.name,
          originalTo: join.name,
          declaredOn: cube.name,
        };

        return [`${cube.name}-${join.name}`, joinEdge] as [string, JoinEdge];
      });
  }

  protected buildJoinNode(cube: CubeDefinition): Record<string, 1> {
    if (!cube.joins) {
      return {};
    }

    return cube.joins.reduce((acc, join) => {
      acc[join.name] = 1;
      return acc;
    }, {} as Record<string, 1>);
  }

  public buildJoin(cubesToJoin: JoinHints): FinishedJoinTree | null {
    if (!cubesToJoin.length) {
      return null;
    }
    // Normalize sentinel-prefixed plain arrays into typed `ExplicitJoinHint`s.
    // This runs unconditionally so callers from either pipeline (JS BaseQuery,
    // or the Tesseract bridge in `cubesqlplanner`) get the same treatment —
    // Tesseract forwards raw `joinHints` (with sentinels intact) across the FFI
    // and calls `JoinGraph.build_join` directly, so the decoding has to happen
    // here, not in BaseQuery. Already-typed `ExplicitJoinHint` entries (from
    // BaseQuery's defensive early parse, or from view enrichment) pass through
    // untouched. Cheap when no sentinel is present — single `.map` over an
    // already-small hints array.
    cubesToJoin = cubesToJoin.map(hint => {
      if (Array.isArray(hint) && hint.length > 1 && hint[0] === EXPLICIT_JOIN_HINT_SENTINEL) {
        return { path: hint.slice(1), explicit: true };
      }
      return hint;
    });
    const key = JSON.stringify(cubesToJoin);
    if (!this.builtJoins[key]) {
      // When any ExplicitJoinHint is present (and the feature is enabled), pin the
      // root to `cubesToJoin[0]` — the SQL FROM cube. This prevents the candidate-
      // root sweep from silently flipping direction by picking a different hint
      // as root, which would discard the explicit-direction intent. Per-hint
      // explicit semantics (reverse-edge synthesis) continue to apply to every
      // ExplicitJoinHint in the same query, including ones whose first cube isn't
      // the FROM cube (e.g., `FROM a LEFT JOIN b LEFT JOIN c ON __cubeExplicitJoinField`).
      const reverseEnabled = bidirectionalJoinsEnabled();
      const hasExplicit = reverseEnabled && cubesToJoin.some(isExplicitJoinHint);

      let join: JoinTree | null;
      if (hasExplicit) {
        const root = cubesToJoin[0];
        join = this.buildJoinTreeForRoot(root, R.without([root], cubesToJoin));
      } else {
        join = R.pipe<
            JoinHints,
            Array<JoinTree | null>,
            Array<JoinTree>,
            Array<JoinTree>
        >(
          R.map(
            (cube: JoinHint): JoinTree | null => this.buildJoinTreeForRoot(cube, R.without([cube], cubesToJoin))
          ),
          // @ts-ignore
          R.filter(R.identity),
          R.sortBy((joinTree: JoinTree) => joinTree.joins.length)
        // @ts-ignore
        )(cubesToJoin)[0];
      }

      if (!join) {
        throw new UserError(`Can't find join path to join ${cubesToJoin.map(v => `'${JSON.stringify(v)}'`).join(', ')}`);
      }

      this.builtJoins[key] = Object.assign(join, {
        multiplicationFactor: R.compose<
          JoinHints,
          Array<[string, boolean]>,
          Record<string, boolean>
        >(
          R.fromPairs,
          R.map(v => [this.cubeFromPath(v), this.findMultiplicationFactorFor(this.cubeFromPath(v), join!.joins)])
        )(cubesToJoin)
      });
    }
    return this.builtJoins[key];
  }

  protected cubeFromPath(cubePath: JoinHint): string {
    const path = joinHintPath(cubePath);
    return path[path.length - 1];
  }

  // Build a synthetic reverse JoinEdge from a declared edge. Used in explicit-direction
  // traversal when the requested step is declared only in the opposite direction.
  // Swaps from/to/originalFrom/originalTo so downstream consumers see the actual
  // traversal direction; preserves `declaredOn` so SQL emission can still resolve
  // `${CUBE}` against the original declaring cube; inverts the normalized
  // relationship value so multiplication semantics stay correct.
  protected synthesizeReverseEdge(declared: JoinEdge): JoinEdge {
    const invertRelationship = (rel: string): string => {
      if (rel === 'hasMany') return 'belongsTo';
      if (rel === 'belongsTo') return 'hasMany';
      return rel; // hasOne is symmetric
    };

    return {
      join: {
        ...declared.join,
        relationship: invertRelationship(declared.join.relationship),
      },
      from: declared.to,
      to: declared.from,
      originalFrom: declared.originalTo,
      originalTo: declared.originalFrom,
      declaredOn: declared.declaredOn,
      synthetic: true,
    };
  }

  protected buildJoinTreeForRoot(root: JoinHint, cubesToJoin: JoinHints): JoinTree | null {
    const self = this;

    const { graph } = this;
    if (graph === null) {
      // JoinGraph was not compiled
      return null;
    }

    // Destructure the root. An explicit-hint root propagates the explicit flag to
    // the tail it pushes back as a sub-hint, so each step of an explicit path is
    // walked with explicit semantics. Non-explicit root branches keep the legacy
    // shape unchanged so behavior outside the feature is identical to pre-PR.
    let rootCube: string;
    if (isExplicitJoinHint(root)) {
      const [newRoot, ...additionalToJoin] = root.path;
      rootCube = newRoot;
      if (additionalToJoin.length > 0) {
        cubesToJoin = [{ path: additionalToJoin, explicit: true }, ...cubesToJoin];
      }
    } else if (Array.isArray(root)) {
      const [newRoot, ...additionalToJoin] = root;
      rootCube = newRoot;
      if (additionalToJoin.length > 0) {
        cubesToJoin = [additionalToJoin, ...cubesToJoin];
      }
    } else {
      rootCube = root;
    }

    // The bidirectional-joins feature is opt-in via three env vars. The flag is
    // evaluated once per buildJoinTreeForRoot call so a single query can't end up
    // with a mix of gated and ungated behavior across hints.
    const reverseEnabled = bidirectionalJoinsEnabled();

    const nodesJoined: Record<string, boolean> = {};
    const result = cubesToJoin.map(joinHint => {
      // Only ExplicitJoinHint is allowed to reach the reverse-synthesis branch.
      // Plain string/string[] hints (which is what every other producer emits —
      // `__cubeJoinField`, REST joinHints, member resolution, /meta, etc.) keep
      // the strictly directed traversal of pre-PR behavior.
      const hintExplicit = isExplicitJoinHint(joinHint) && reverseEnabled;
      const hintPath = joinHintPath(joinHint);
      let prevNode = rootCube;
      return hintPath.filter(toJoin => toJoin !== prevNode).map(toJoin => {
        if (nodesJoined[toJoin]) {
          prevNode = toJoin;
          return { joins: [] };
        }

        const path = graph.path(prevNode, toJoin);
        if (path && Array.isArray(path)) {
          const foundJoins = self.joinsByPath(path);
          prevNode = toJoin;
          nodesJoined[toJoin] = true;
          return { cubes: path, joins: foundJoins };
        }

        // Reverse-edge synthesis only for explicit hints with the feature on.
        // For every other source the legacy "no directed path → no join tree"
        // behavior is preserved.
        if (hintExplicit) {
          const reverseEdge = self.edges[`${toJoin}-${prevNode}`];
          if (reverseEdge) {
            const synthetic = self.synthesizeReverseEdge(reverseEdge);
            prevNode = toJoin;
            nodesJoined[toJoin] = true;
            return { cubes: [reverseEdge.originalTo, reverseEdge.originalFrom], joins: [synthetic] };
          }
        }

        if (!path) {
          return null;
        }
        // Unexpected object return from graph (only happens when path cost was requested)
        return null;
      });
    }).reduce((a, b) => a.concat(b), [])
      // @ts-ignore
      .reduce((joined, res) => {
        if (!res || !joined) {
          return null;
        }
        const indexedPairs = R.compose<
          Array<JoinEdge>,
          Array<[number, JoinEdge]>
        >(
          R.addIndex(R.map)((j, i) => [i + joined.joins.length, j])
        );
        return {
          joins: [...joined.joins, ...indexedPairs(res.joins)],
        };
      }, { joins: [] });

    if (!result) {
      return null;
    }

    const pairsSortedByIndex: (joins: [number, JoinEdge][]) => JoinEdge[] =
      R.compose<
        Array<[number, JoinEdge]>,
        Array<[number, JoinEdge]>,
        Array<JoinEdge>,
        Array<JoinEdge>
      >(
        R.uniq,
        R.map(([_, join]: [number, JoinEdge]) => join),
        R.sortBy(([index]: [number, JoinEdge]) => index)
      );
    return {
      // @ts-ignore
      joins: pairsSortedByIndex(result.joins),
      root: rootCube
    };
  }

  protected findMultiplicationFactorFor(cube: string, joins: JoinTreeJoins): boolean {
    const visited = {};
    const self = this;
    function findIfMultipliedRecursive(currentCube: string) {
      if (visited[currentCube]) {
        return false;
      }
      visited[currentCube] = true;
      function nextNode(nextJoin: JoinEdge): string {
        return nextJoin.from === currentCube ? nextJoin.to : nextJoin.from;
      }
      const nextJoins = joins.filter(j => j.from === currentCube || j.to === currentCube);
      if (nextJoins.find(
        nextJoin => self.checkIfCubeMultiplied(currentCube, nextJoin) && !visited[nextNode(nextJoin)]
      )) {
        return true;
      }
      return !!nextJoins.find(
        nextJoin => findIfMultipliedRecursive(nextNode(nextJoin))
      );
    }
    return findIfMultipliedRecursive(cube);
  }

  protected checkIfCubeMultiplied(cube: string, join: JoinEdge): boolean {
    return join.from === cube && join.join.relationship === 'hasMany' ||
      join.to === cube && join.join.relationship === 'belongsTo';
  }

  protected joinsByPath(path: string[]): JoinEdge[] {
    return R.range(0, path.length - 1).map(i => this.edges[`${path[i]}-${path[i + 1]}`]);
  }

  public connectedComponents(): Record<string, number> {
    if (!this.cachedConnectedComponents) {
      let componentId = 1;
      const components = {};
      R.toPairs(this.nodes).map(nameToConnection => nameToConnection[0]).forEach(node => {
        this.findConnectedComponent(componentId, node, components);
        componentId += 1;
      });
      this.cachedConnectedComponents = components;
    }
    return this.cachedConnectedComponents;
  }

  protected findConnectedComponent(componentId: number, node: string, components: Record<string, number>): void {
    if (!components[node]) {
      components[node] = componentId;
      R.toPairs(this.undirectedNodes[node])
        .map(connectedNodeNames => connectedNodeNames[0])
        .forEach(connectedNode => {
          this.findConnectedComponent(componentId, connectedNode, components);
        });
    }
  }
}
