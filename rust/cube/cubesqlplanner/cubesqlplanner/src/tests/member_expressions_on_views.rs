use crate::cube_bridge::member_expression::{ExpressionStruct, MemberExpressionExpressionDef};
use crate::cube_bridge::member_sql::MemberSql;
use crate::cube_bridge::options_member::OptionsMember;
use crate::test_fixtures::cube_bridge::{
    members_from_strings, MockBaseQueryOptions, MockExpressionStruct,
    MockMemberExpressionDefinition, MockMemberSql, MockSchema, MockStructWithSqlMember,
};
use crate::test_fixtures::test_utils::TestContext;
use cubenativeutils::CubeError;
use indoc::indoc;
use std::rc::Rc;

fn create_test_context() -> TestContext {
    let schema = MockSchema::from_yaml_file("common/many_to_one_views.yaml");
    TestContext::new(schema).unwrap()
}

fn make_member_expression(expression_name: &str, cube_name: &str, sql: &str) -> OptionsMember {
    let member_sql: Rc<dyn MemberSql> = Rc::new(MockMemberSql::new(sql).unwrap());
    let expr = MockMemberExpressionDefinition::builder()
        .expression_name(Some(expression_name.to_string()))
        .name(Some(expression_name.to_string()))
        .cube_name(Some(cube_name.to_string()))
        .expression(MemberExpressionExpressionDef::Sql(member_sql))
        .build();
    OptionsMember::MemberExpression(Rc::new(expr))
}

// Builds a `PatchMeasure` member expression that adds one ad-hoc CASE-WHEN
// filter to `source_measure` — the SQL-API mechanism for pushing a filter
// inside a measure's aggregation.
fn make_patched_measure(
    expression_name: &str,
    cube_name: &str,
    source_measure: &str,
    filter_sql: &str,
) -> OptionsMember {
    let filter = MockStructWithSqlMember::builder()
        .sql(filter_sql.to_string())
        .build();
    let expr_struct = MockExpressionStruct::builder()
        .expression_type("PatchMeasure".to_string())
        .source_measure(Some(source_measure.to_string()))
        .add_filters(Some(vec![Rc::new(filter)]))
        .build();
    let expr = MockMemberExpressionDefinition::builder()
        .expression_name(Some(expression_name.to_string()))
        .name(Some(expression_name.to_string()))
        .cube_name(Some(cube_name.to_string()))
        .expression(MemberExpressionExpressionDef::Struct(
            Rc::new(expr_struct) as Rc<dyn ExpressionStruct>
        ))
        .build();
    OptionsMember::MemberExpression(Rc::new(expr))
}

fn build_options_with_member_expression(
    ctx: &TestContext,
    extra_measure: OptionsMember,
) -> Rc<dyn crate::cube_bridge::base_query_options::BaseQueryOptions> {
    let mut measures = members_from_strings(vec![
        "many_to_one_view.root_val_avg",
        "many_to_one_view.child_val_avg",
    ]);
    measures.push(extra_measure);

    Rc::new(
        MockBaseQueryOptions::builder()
            .cube_evaluator(ctx.query_tools().cube_evaluator().clone())
            .base_tools(ctx.query_tools().base_tools().clone())
            .join_graph(ctx.query_tools().join_graph().clone())
            .security_context(ctx.security_context().clone())
            .measures(Some(measures))
            .dimensions(Some(members_from_strings(vec![
                "many_to_one_view.root_dim",
                "many_to_one_view.child_dim",
            ])))
            .build(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_base_query() {
    let ctx = create_test_context();

    let query_yaml = indoc! {"
        measures:
          - many_to_one_view.root_val_avg
          - many_to_one_view.child_val_avg
        dimensions:
          - many_to_one_view.root_dim
          - many_to_one_view.child_dim
    "};

    ctx.build_sql(query_yaml).unwrap();

    if let Some(result) = ctx
        .try_execute_pg(query_yaml, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_one_sum() {
    let ctx = create_test_context();
    let expr = make_member_expression("one_sum", "many_to_one_view", "SUM(1)");
    let options = build_options_with_member_expression(&ctx, expr);
    ctx.build_sql_from_options(options.clone()).unwrap();

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

// JS member-expressions-on-views.test.ts "many_to_one_view › one_sum":
// shares (root.dim, child.dim) across several root rows so the child
// measure feels the row multiplication. With proper dedup,
// (foo, foo).child_val_avg = (100 + 300) / 2 = 200; without dedup the
// many_to_one join injects child #1 twice and yields 166.66.
#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_one_sum_multiplied() {
    let ctx = create_test_context();
    let expr = make_member_expression("one_sum", "many_to_one_view", "SUM(1)");
    let options = build_options_with_member_expression(&ctx, expr);
    ctx.build_sql_from_options(options.clone()).unwrap();

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_multiplied_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_root_val_sum() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "root_val_sum_expr",
        "many_to_one_view",
        "{many_to_one_view.root_val_sum}",
    );
    let options = build_options_with_member_expression(&ctx, expr);
    ctx.build_sql_from_options(options.clone()).unwrap();

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_root_distinct_dim() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "root_distinct_dim",
        "many_to_one_view",
        "COUNT(DISTINCT {many_to_one_view.root_test_dim})",
    );
    let options = build_options_with_member_expression(&ctx, expr);
    ctx.build_sql_from_options(options.clone()).unwrap();

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_child_val_sum() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "child_val_sum_expr",
        "many_to_one_view",
        "{many_to_one_view.child_val_sum}",
    );
    let options = build_options_with_member_expression(&ctx, expr);
    ctx.build_sql_from_options(options.clone()).unwrap();

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_child_distinct_dim() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "child_distinct_dim",
        "many_to_one_view",
        "COUNT(DISTINCT {many_to_one_view.child_test_dim})",
    );
    let options = build_options_with_member_expression(&ctx, expr);
    ctx.build_sql_from_options(options.clone()).unwrap();

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }
}

// A PatchMeasure adding a CASE-WHEN filter to a measure exposed through a view
// (`root_val_sum`, a SUM) must resolve the reference chain to the owning cube
// measure so the filter is pushed inside the aggregation.
// root_test_dim='rt_x' → roots 1,2 → SUM = 10 + 20 = 30.
#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_patched_measure_filter() -> Result<(), CubeError> {
    let ctx = create_test_context();
    let expr = make_patched_measure(
        "filtered_root_sum",
        "many_to_one_view",
        "many_to_one_view.root_val_sum",
        "{many_to_one_view.root_test_dim} = 'rt_x'",
    );

    let options = Rc::new(
        MockBaseQueryOptions::builder()
            .cube_evaluator(ctx.query_tools().cube_evaluator().clone())
            .base_tools(ctx.query_tools().base_tools().clone())
            .join_graph(ctx.query_tools().join_graph().clone())
            .security_context(ctx.security_context().clone())
            .measures(Some(vec![expr]))
            .build(),
    );

    let sql = ctx.build_sql_from_options(options.clone())?;
    // The ad-hoc filter is pushed inside the aggregation (measure_filter.rs
    // renders `CASE WHEN <filter> THEN <result> END`), not as an outer WHERE.
    assert!(
        sql.contains("CASE WHEN"),
        "ad-hoc filter must be pushed inside the aggregation, got: {sql}"
    );

    if let Some(result) = ctx
        .try_execute_pg_from_options(options, "many_to_one_tables.sql")
        .await
    {
        insta::assert_snapshot!(result);
    }

    Ok(())
}

/// Regression: a dimension-only member expression that references two dimensions of the SAME
/// underlying cube (`root_dim` and `root_test_dim`, both on `many_to_one_root`) must plan
/// successfully. Before the de-dup fix in
/// `MemberExpressionSymbol::cube_names_if_dimension_only_expression`, the collected cube-name list
/// was `["many_to_one_root", "many_to_one_root"]`, which tripped the `cube_names.len() == 1` guard
/// in `collect_multiplied_measures` and failed with
/// "Expected single cube for dimension-only measure".
#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_same_cube_two_dim_expr() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "root_two_dim_min",
        "many_to_one_view",
        "MIN({many_to_one_view.root_dim} || {many_to_one_view.root_test_dim})",
    );
    let options = build_options_with_member_expression(&ctx, expr);

    let sql = ctx
        .build_sql_from_options(options)
        .expect("same-cube two-dimension expression should plan after de-dup fix");
    assert!(
        sql.contains("test_dim"),
        "generated SQL should reference both root dimensions: {sql}"
    );
}

/// The single-cube guard must still reject a dimension-only expression that spans two DISTINCT
/// cubes (`root_dim` on `many_to_one_root`, `child_dim` on `many_to_one_child`). That is a
/// separate, unimplemented case — not the same-cube duplication the de-dup fix addresses — so the
/// de-dup must not silently admit it.
#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_cross_cube_two_dim_expr_still_rejected() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "cross_cube_min",
        "many_to_one_view",
        "MIN({many_to_one_view.root_dim} || {many_to_one_view.child_dim})",
    );
    let options = build_options_with_member_expression(&ctx, expr);

    let err = ctx
        .build_sql_from_options(options)
        .expect_err("cross-cube dimension-only expression should still be rejected");
    assert!(
        err.to_string().contains("Expected single cube"),
        "expected single-cube guard error, got: {err}"
    );
}

/// When the owning cube *is* multiplied (here `many_to_one_child` is the "one" side of the
/// `many_to_one` join, so its rows fan out across roots), a same-cube two-dimension expression must
/// still route through the symmetric-aggregate (multiplied-subquery) path rather than aggregating
/// over the duplicated rows. This locks in that the de-dup fix preserves fan-out correctness: the
/// `MIN(...)` is evaluated inside the by-primary-key `keys` subquery, not the raw join.
#[tokio::test(flavor = "multi_thread")]
async fn test_many_to_one_view_same_cube_two_dim_expr_on_multiplied_cube() {
    let ctx = create_test_context();
    let expr = make_member_expression(
        "child_two_dim_min",
        "many_to_one_view",
        "MIN({many_to_one_view.child_dim} || {many_to_one_view.child_test_dim})",
    );
    let options = build_options_with_member_expression(&ctx, expr);

    let sql = ctx
        .build_sql_from_options(options)
        .expect("same-cube two-dimension expression on a multiplied cube should plan");

    assert!(
        sql.contains("child_two_dim_min"),
        "generated SQL should emit the expression: {sql}"
    );
    // Symmetric-aggregate dedup subquery for the multiplied child cube.
    assert!(
        sql.contains(r#"AS "keys""#),
        "expected the multiplied-cube keys subquery (symmetric aggregate): {sql}"
    );
    // The expression itself aggregates over the keyed (deduplicated) child rows, confirming it was
    // routed into the multiplied subquery rather than the raw fanned-out join.
    assert!(
        sql.contains("MIN(") && sql.contains("many_to_one_child_key_many_to_one_child"),
        "expected MIN(...) evaluated inside the multiplied (keyed) subquery: {sql}"
    );
}
