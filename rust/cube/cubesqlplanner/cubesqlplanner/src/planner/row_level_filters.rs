use crate::cube_bridge::base_query_options::RowLevelFilterItem;
use crate::logical_plan::LogicalJoin;
use crate::planner::collectors::{
    collect_calc_group_dims_from_nodes, collect_cube_names_from_symbols,
};
use crate::planner::filter::compiler::FilterCompiler;
use crate::planner::filter::tree_ops::eq_with_member;
use crate::planner::filter::{Filter, FilterItem};
use crate::planner::query_tools::QueryTools;
use crate::planner::Compiler;
use cubenativeutils::CubeError;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;

/// Current policy-origin facts compiled independently of editable filters.
/// The original aggregate stays in the logical filter graph for planning and
/// pre-aggregation matching. Placement can remove exactly one occurrence only
/// after proving every input constraint has a direct physical owner.
pub(crate) struct RowLevelFilters {
    aggregate: FilterItem,
    inputs: HashMap<String, FilterItem>,
}

impl fmt::Debug for RowLevelFilters {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RowLevelFilters")
            .field("cubes", &self.inputs.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl RowLevelFilters {
    pub(crate) fn compile(
        origins: Option<&[RowLevelFilterItem]>,
        compiler: &mut Compiler,
        query_tools: Rc<QueryTools>,
    ) -> Result<Option<Self>, CubeError> {
        let Some(origins) = origins.filter(|items| !items.is_empty()) else {
            return Ok(None);
        };
        let mut inputs = HashMap::new();
        let mut aggregate_items = Vec::new();
        for origin in origins {
            // A view, cross-cube predicate or aggregate restriction cannot be
            // reinterpreted as a local raw-row restriction. Keep it global.
            let cube = query_tools
                .cube_evaluator()
                .cube_from_path(origin.cube.clone())?;
            if cube.static_data().is_view.unwrap_or(false) {
                return Ok(None);
            }
            let mut filters = FilterCompiler::new(compiler, query_tools.clone());
            filters.add_item(&origin.filter)?;
            let (dimensions, time, measures) = filters.extract_result();
            if dimensions.len() != 1 || !time.is_empty() || !measures.is_empty() {
                return Ok(None);
            }
            let filter = dimensions.into_iter().next().unwrap();
            let symbols = filter.all_member_evaluators();
            if symbols.is_empty()
                || symbols.iter().any(|symbol| {
                    symbol.cube_name() != origin.cube
                        || symbol.as_dimension().map_or(true, |dimension| {
                            dimension.is_view() || dimension.is_sub_query()
                        })
                })
                || collect_cube_names_from_symbols(&symbols)?
                    .iter()
                    .any(|cube| cube != &origin.cube)
                || !collect_calc_group_dims_from_nodes(symbols.iter())?.is_empty()
            {
                return Ok(None);
            }
            if inputs.insert(origin.cube.clone(), filter.clone()).is_some() {
                return Ok(None);
            }
            aggregate_items.push(filter);
        }
        Ok(Some(Self {
            aggregate: Filter {
                items: aggregate_items,
            }
            .to_filter_item()
            .unwrap(),
            inputs,
        }))
    }

    pub(crate) fn input_filter(&self, cube: &str) -> Option<&FilterItem> {
        self.inputs.get(cube)
    }

    pub(crate) fn place_for_join(&self, join: &LogicalJoin, filter: &mut Option<Filter>) -> bool {
        let Some(root) = join.root() else {
            return false;
        };
        if join.joins().is_empty()
            || !join.dimension_subqueries().is_empty()
            || !join.subquery_joins().is_empty()
        {
            return false;
        }
        let root_name = root.cube().name();
        let mut cube_names = HashSet::from([root_name.clone()]);
        for item in join.joins() {
            if !cube_names.insert(item.cube().cube().name().clone()) {
                return false;
            }
        }
        if self.inputs.keys().any(|cube| !cube_names.contains(cube))
            || !self.inputs.keys().any(|cube| cube != root_name)
        {
            return false;
        }
        let Some(current) = filter else {
            return false;
        };
        // Never prune arbitrary matching leaves or all duplicates. An authored
        // right-side filter (even one identical to the policy) remains WHERE.
        let Some(index) = current
            .items
            .iter()
            .rposition(|item| eq_with_member(item, &self.aggregate))
        else {
            return false;
        };
        current.items.remove(index);
        if let Some(root_filter) = self.inputs.get(root_name) {
            current.items.push(root_filter.clone());
        }
        if current.items.is_empty() {
            *filter = None;
        }
        true
    }
}
