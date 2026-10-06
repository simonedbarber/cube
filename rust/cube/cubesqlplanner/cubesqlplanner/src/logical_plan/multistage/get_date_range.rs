use crate::logical_plan::*;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use std::rc::Rc;

/// CTE that resolves the actual date range of a time dimension at
/// query time (used by rolling windows when no literal range is
/// given).
pub struct MultiStageGetDateRange {
    pub time_dimension: Rc<MemberSymbol>,
    pub source: Rc<LogicalJoin>,
    pub filter: Rc<LogicalFilter>,
}

impl LogicalNode for MultiStageGetDateRange {
    fn as_plan_node(self: &Rc<Self>) -> PlanNode {
        PlanNode::MultiStageGetDateRange(self.clone())
    }

    fn inputs(&self) -> Vec<PlanNode> {
        vec![self.source.as_plan_node()]
    }

    fn with_inputs(self: Rc<Self>, inputs: Vec<PlanNode>) -> Result<Rc<Self>, CubeError> {
        check_inputs_len(&inputs, 1, self.node_name())?;
        let source = &inputs[0];

        Ok(Rc::new(Self {
            time_dimension: self.time_dimension.clone(),
            source: source.clone().into_logical_node()?,
            filter: self.filter.clone(),
        }))
    }

    fn node_name(&self) -> &'static str {
        "MultiStageGetDateRange"
    }

    fn try_from_plan_node(plan_node: PlanNode) -> Result<Rc<Self>, CubeError> {
        if let PlanNode::MultiStageGetDateRange(item) = plan_node {
            Ok(item)
        } else {
            Err(cast_error(&plan_node, "MultiStageGetDateRange"))
        }
    }
}

impl PrettyPrint for MultiStageGetDateRange {
    fn pretty_print(&self, result: &mut PrettyPrintResult, state: &PrettyPrintState) {
        result.println("Get Date Range", state);
        let state = state.new_level();
        let details_state = state.new_level();
        result.println(
            &format!("time_dimension: {}", self.time_dimension.full_name()),
            &details_state,
        );
        result.println("filters:", &state);
        self.filter.pretty_print(result, &details_state);
        result.println("source:", &state);
        self.source.pretty_print(result, &details_state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::filter::FilterItem;
    use crate::test_fixtures::cube_bridge::MockSchema;
    use crate::test_fixtures::test_utils::TestContext;

    #[test]
    fn replacing_range_source_preserves_normalized_filter_ownership() -> Result<(), CubeError> {
        let ctx = TestContext::new(MockSchema::from_yaml_file("common/visitors.yaml"))?;
        let properties = ctx.create_query_properties(
            "dimensions: [visitors.source]\nfilters:\n  - member: visitors.source\n    operator: equals\n    values: [paid]\n",
        )?;
        let dimension_filters = properties.dimensions_filters().clone();
        assert_eq!(dimension_filters.len(), 1);
        let segment = FilterItem::Segment(ctx.create_segment("visitors.google")?);
        let filter = Rc::new(LogicalFilter {
            dimensions_filters: dimension_filters.clone(),
            time_dimensions_filters: dimension_filters.clone(),
            segments: vec![segment],
            // A HAVING tree remains separate from the source-row population.
            measures_filter: dimension_filters,
        });
        let original = Rc::new(MultiStageGetDateRange {
            time_dimension: ctx.create_time_dimension("visitors.created_at", Some("day"))?,
            source: Rc::new(LogicalJoin::builder().build()),
            filter: filter.clone(),
        });
        let replacement = Rc::new(LogicalJoin::builder().build());
        let updated = original.with_inputs(vec![replacement.as_plan_node()])?;
        assert!(Rc::ptr_eq(&updated.source, &replacement));
        assert!(Rc::ptr_eq(&updated.filter, &filter));
        assert_eq!(updated.filter.all_filters().unwrap().items.len(), 3);
        assert_eq!(updated.filter.measures_filter().unwrap().items.len(), 1);
        Ok(())
    }
}
