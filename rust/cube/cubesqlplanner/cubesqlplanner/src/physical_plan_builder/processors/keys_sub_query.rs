use super::super::{LogicalNodeProcessor, ProcessableNode, PushDownBuilderContext};
use crate::logical_plan::{all_symbols, KeysSubQuery, LogicalJoin};
use crate::physical_plan::{
    CalcGroupItem, CalcGroupsJoin, Expr, From, ReferencesBuilder, Select, SelectBuilder,
};
use crate::physical_plan_builder::PhysicalPlanBuilder;
use crate::planner::collectors::{
    collect_calc_group_dims_from_nodes, collect_cube_names_from_symbols,
};
use crate::planner::symbols::transforms::{get_filtered_values, measures_render_modifier};
use crate::planner::{MeasureRenderModifier, MemberSymbol};
use cubenativeutils::CubeError;
use itertools::Itertools as _;
use std::rc::Rc;

pub struct KeysSubQueryProcessor<'a> {
    builder: &'a PhysicalPlanBuilder,
}

impl<'a> LogicalNodeProcessor<'a, KeysSubQuery> for KeysSubQueryProcessor<'a> {
    type PhysycalNode = Rc<Select>;
    fn new(builder: &'a PhysicalPlanBuilder) -> Self {
        Self { builder }
    }

    fn process(
        &self,
        keys_subquery: &KeysSubQuery,
        context: &PushDownBuilderContext,
    ) -> Result<Self::PhysycalNode, CubeError> {
        self.process_with_identity_measures(keys_subquery, context, &[])
    }
}

impl<'a> KeysSubQueryProcessor<'a> {
    /// Carry only measures whose value is fixed by the existing root identity.
    /// The caller establishes eligibility; joins, predicates and DISTINCT remain.
    pub(super) fn process_with_identity_measures(
        &self,
        keys_subquery: &KeysSubQuery,
        context: &PushDownBuilderContext,
        measures: &[Rc<MemberSymbol>],
    ) -> Result<Rc<Select>, CubeError> {
        let query_tools = self.builder.query_tools();
        let alias_prefix = Some(format!(
            "{}_key",
            query_tools.alias_for_cube(&keys_subquery.pk_cube().cube().name())?
        ));

        let mut context = context.clone();
        context.alias_prefix = alias_prefix;

        let mut context_factory = context.make_sql_nodes_factory()?;
        // Cube joins here are LEFT joins. If all projected values and WHERE
        // members are root-owned, they only multiply identical key rows which
        // DISTINCT removes. Keep every join for right-side attribution/filtering,
        // opaque subquery joins, protected join filters or contextual stages.
        let all_symbols = all_symbols(&keys_subquery.schema(), &keys_subquery.filter());
        let mut projected_symbols = all_symbols.clone();
        projected_symbols.extend(keys_subquery.primary_keys_dimensions().iter().cloned());
        projected_symbols.extend(measures.iter().cloned());
        let root = keys_subquery.pk_cube().cube();
        let root_only = !measures.is_empty()
            && keys_subquery.source().subquery_joins().is_empty()
            && keys_subquery.source().dimension_subqueries().is_empty()
            && context.row_level_join_filters.is_none()
            && context.get_multi_stage_dimensions()?.is_none()
            && collect_cube_names_from_symbols(&projected_symbols)?
                .iter()
                .all(|name| name == root.name());
        let source = if root_only {
            let source = LogicalJoin::builder()
                .root(Some(keys_subquery.pk_cube().clone()))
                .build();
            self.builder.process_node(&source, &context)?
        } else {
            self.builder
                .process_node(keys_subquery.source().as_ref(), &context)?
        };

        //FIXME duplication with QueryProcessor
        let calc_group_dims = collect_calc_group_dims_from_nodes(all_symbols.iter())?;

        let filter = keys_subquery.filter().all_filters();
        let calc_groups_items = calc_group_dims.into_iter().map(|dim| {
            let values = get_filtered_values(&dim, &filter);
            CalcGroupItem {
                symbol: dim,
                values,
            }
        });
        for item in calc_groups_items
            .clone()
            .filter(|itm| itm.values.len() == 1)
        {
            context_factory.add_render_reference(item.symbol.full_name(), item.values[0].clone());
        }
        let calc_groups_to_join = calc_groups_items
            .filter(|itm| itm.values.len() > 1)
            .collect_vec();
        let source = if calc_groups_to_join.is_empty() {
            source
        } else {
            let groups_join = CalcGroupsJoin::try_new(source, calc_groups_to_join)?;
            From::new_from_calc_groups_join(groups_join)
        };

        let references_builder = ReferencesBuilder::new(source.clone());
        let mut select_builder = SelectBuilder::new(source);
        self.builder.resolve_subquery_dimensions_references(
            &keys_subquery.source().dimension_subqueries(),
            &references_builder,
            &mut context_factory,
        )?;
        for member in keys_subquery.schema().all_dimensions() {
            let alias = member.alias();
            references_builder.resolve_references_for_member(
                member.clone(),
                &None,
                context_factory.render_references_mut(),
            )?;
            select_builder.add_projection_member(member, Some(alias));
        }

        if !context.dimensions_query {
            for member in keys_subquery.primary_keys_dimensions().iter() {
                // A primary key that is also a query dimension is already
                // projected above. Projecting it again would put two columns
                // under one alias, making every reference to it from the
                // enclosing re-join ambiguous. Symbols are matched the way
                // `Schema::find_column_for_member` matches them, so that the
                // re-join resolves to the surviving column.
                let resolved = member.clone().resolve_reference_chain();
                if keys_subquery
                    .schema()
                    .all_dimensions()
                    .any(|dim| dim.clone().resolve_reference_chain() == resolved)
                {
                    continue;
                }
                let alias = member.alias();
                references_builder.resolve_references_for_member(
                    member.clone(),
                    &None,
                    context_factory.render_references_mut(),
                )?;
                select_builder.add_projection_member(member, Some(alias));
            }
        }

        for measure in measures {
            let raw = measures_render_modifier(measure, &MeasureRenderModifier::RawValue)?;
            references_builder.resolve_references_for_member(
                raw.clone(),
                &None,
                context_factory.render_references_mut(),
            )?;
            select_builder.add_projection_member_expr(
                measure,
                Expr::IdentityValue {
                    value: Box::new(Expr::new_member(raw)),
                    keys: keys_subquery
                        .primary_keys_dimensions()
                        .iter()
                        .cloned()
                        .map(Expr::new_member)
                        .collect(),
                },
                None,
            );
        }
        select_builder.set_distinct();
        select_builder.set_filter(filter);
        let res = Rc::new(select_builder.build(query_tools.clone(), context_factory));
        Ok(res)
    }
}

impl ProcessableNode for KeysSubQuery {
    type ProcessorType<'a> = KeysSubQueryProcessor<'a>;
}
