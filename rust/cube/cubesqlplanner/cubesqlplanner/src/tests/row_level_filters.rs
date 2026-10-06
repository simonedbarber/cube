use crate::cube_bridge::base_query_options::{FilterItem, RowLevelFilterItem};
use crate::test_fixtures::cube_bridge::base_query_options::{filter_and, filter_item, filter_or};
use crate::test_fixtures::cube_bridge::{members_from_strings, MockBaseQueryOptions, MockSchema};
use crate::test_fixtures::test_utils::TestContext;
use std::rc::Rc;

fn sql(authored_right: bool, protected: bool, ungrouped: bool, duplicate: bool) -> String {
    let context = TestContext::new(MockSchema::from_yaml_file("common/simple.yaml")).unwrap();
    let left = filter_item("orders.priority", "equals", vec!["high"]);
    let right = filter_or(vec![
        filter_item("customers.city", "equals", vec!["New York"]),
        filter_item("customers.city", "equals", vec!["Boston"]),
    ]);
    let aggregate = filter_and(vec![left.clone(), right.clone()]);
    let mut filters = vec![filter_item("orders.status", "equals", vec!["paid"])];
    if authored_right {
        filters.push(right.clone());
    }
    if duplicate {
        filters.push(aggregate.clone());
    }
    filters.push(aggregate);
    let origins = protected.then(|| {
        vec![
            RowLevelFilterItem {
                cube: "orders".to_string(),
                filter: left,
            },
            RowLevelFilterItem {
                cube: "customers".to_string(),
                filter: right,
            },
        ]
    });
    build(&context, filters, origins, ungrouped)
}

fn build(
    context: &TestContext,
    filters: Vec<FilterItem>,
    origins: Option<Vec<RowLevelFilterItem>>,
    ungrouped: bool,
) -> String {
    let options = MockBaseQueryOptions::builder()
        .cube_evaluator(context.query_tools().cube_evaluator().clone())
        .base_tools(context.query_tools().base_tools().clone())
        .join_graph(context.query_tools().join_graph().clone())
        .security_context(context.security_context().clone())
        .dimensions(Some(members_from_strings(vec![
            "orders.id",
            "customers.name",
        ])))
        .ungrouped(Some(ungrouped))
        .filters(Some(filters))
        .row_level_filters(origins)
        .build();
    context.build_sql_from_options(Rc::new(options)).unwrap()
}

#[test]
fn protected_row_level_filters_compare_members_as_well_as_values() {
    let context = TestContext::new(MockSchema::from_yaml_file("common/simple.yaml")).unwrap();
    let origin = RowLevelFilterItem {
        cube: "customers".to_string(),
        filter: filter_item("customers.city", "equals", vec!["A"]),
    };
    let sql = build(
        &context,
        vec![filter_item("customers.name", "equals", vec!["A"])],
        Some(vec![origin]),
        true,
    );
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(
        !from.contains("city"),
        "another member cannot impersonate the protected aggregate: {sql}"
    );
    assert!(remaining.contains("name"), "{sql}");
}

#[test]
fn protected_row_level_filters_keep_cross_cube_conditions_global() {
    let context = TestContext::new(MockSchema::from_yaml_file("common/simple.yaml")).unwrap();
    let filter = filter_item("orders.priority", "equals", vec!["high"]);
    let sql = build(
        &context,
        vec![filter.clone()],
        Some(vec![RowLevelFilterItem {
            cube: "customers".to_string(),
            filter,
        }]),
        true,
    );
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(
        !from.contains("priority") && remaining.contains("priority"),
        "{sql}"
    );
}

#[test]
fn protected_row_level_filters_release_the_per_query_graph() {
    let context = TestContext::new(MockSchema::from_yaml_file("common/simple.yaml")).unwrap();
    let weak = Rc::downgrade(context.query_tools().query_tools());
    let filter = filter_item("customers.city", "equals", vec!["New York"]);
    let sql = build(
        &context,
        vec![filter.clone()],
        Some(vec![RowLevelFilterItem {
            cube: "customers".to_string(),
            filter,
        }]),
        true,
    );
    assert!(
        !sql.contains("WHERE"),
        "the only protected restriction belongs to the right input: {sql}"
    );
    drop(context);
    assert_eq!(
        weak.strong_count(),
        0,
        "compiled protected filters must not create an Rc cycle"
    );
}

#[test]
fn protected_row_level_filters_do_not_place_virtual_calc_group_constraints_in_on() {
    let context = TestContext::new(MockSchema::from_yaml_file(
        "common/dimension_kind_tests.yaml",
    ))
    .unwrap();
    let filter = filter_item("test_dims.calc_group", "equals", vec!["option_a"]);
    let origins = vec![RowLevelFilterItem {
        cube: "test_dims".to_string(),
        filter,
    }];
    let compiler = context.query_tools().compiler().clone();
    let compiled = crate::planner::row_level_filters::RowLevelFilters::compile(
        Some(&origins),
        &mut compiler.borrow_mut(),
        context.query_tools().query_tools().clone(),
    )
    .unwrap();
    assert!(
        compiled.is_none(),
        "a virtual dimension has no raw joined-input owner"
    );
}

#[test]
fn protected_row_level_filters_restrict_right_input_before_left_join() {
    let sql = sql(false, true, true, false);
    let (from, remaining) = sql
        .split_once("WHERE")
        .expect("root and user filters stay global");
    assert!(from.contains("LEFT JOIN"), "{sql}");
    assert!(
        from.contains("city"),
        "protected right filter must be in ON: {sql}"
    );
    assert!(
        from.contains(" OR "),
        "grant union must remain grouped: {sql}"
    );
    assert!(
        !remaining.contains("city"),
        "right policy must not remove unmatched rows: {sql}"
    );
    assert!(
        remaining.contains("priority") && remaining.contains("status"),
        "{sql}"
    );
}

#[test]
fn protected_row_level_filters_keep_identical_authored_right_filter_global() {
    let sql = sql(true, true, true, false);
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(from.contains("city"), "{sql}");
    assert!(
        remaining.contains("city"),
        "authored right filter must remain WHERE: {sql}"
    );
}

#[test]
fn protected_row_level_filters_remove_only_one_matching_aggregate() {
    let sql = sql(false, true, true, true);
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(from.contains("city"), "{sql}");
    assert!(
        remaining.contains("city"),
        "authored duplicate must survive: {sql}"
    );
}

#[test]
fn protected_row_level_filters_do_not_infer_origin_from_authored_filter_bytes() {
    let sql = sql(false, false, true, false);
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(
        !from.contains("city"),
        "ordinary filters must not move: {sql}"
    );
    assert!(
        remaining.contains("city") && remaining.contains("priority"),
        "{sql}"
    );
}

#[test]
fn protected_row_level_filters_place_dimension_only_grouped_input_before_deduplication() {
    let sql = sql(false, true, false, false);
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(
        from.contains("city"),
        "dimension-only grouping must retain unmatched left rows: {sql}"
    );
    assert!(
        !remaining.contains("city") && remaining.contains("priority"),
        "right input and root constraints must retain their own owners: {sql}"
    );
    assert!(sql.contains("GROUP BY"), "{sql}");
}

#[test]
fn protected_row_level_filters_keep_grouped_measures_global() {
    let context = TestContext::new(MockSchema::from_yaml_file("common/simple.yaml")).unwrap();
    let left = filter_item("orders.priority", "equals", vec!["high"]);
    let right = filter_item("customers.city", "equals", vec!["New York"]);
    let options = MockBaseQueryOptions::builder()
        .cube_evaluator(context.query_tools().cube_evaluator().clone())
        .base_tools(context.query_tools().base_tools().clone())
        .join_graph(context.query_tools().join_graph().clone())
        .security_context(context.security_context().clone())
        .dimensions(Some(members_from_strings(vec!["customers.name"])))
        .measures(Some(members_from_strings(vec!["orders.count"])))
        .filters(Some(vec![filter_and(vec![left.clone(), right.clone()])]))
        .row_level_filters(Some(vec![
            RowLevelFilterItem {
                cube: "orders".to_string(),
                filter: left,
            },
            RowLevelFilterItem {
                cube: "customers".to_string(),
                filter: right,
            },
        ]))
        .build();
    let sql = context.build_sql_from_options(Rc::new(options)).unwrap();
    let (from, remaining) = sql.split_once("WHERE").unwrap();
    assert!(
        !from.contains("city"),
        "measure input has not been qualified for placement: {sql}"
    );
    assert!(
        remaining.contains("city") && remaining.contains("priority"),
        "{sql}"
    );
}
