use cubeclient::models::{
    V1LoadRequestQuery, V1LoadRequestQueryFilterItem, V1LoadRequestQueryTimeDimension,
};
use datafusion::physical_plan::displayable;
use pretty_assertions::assert_eq;

use crate::compile::{
    rewrite::rewriter::Rewriter,
    test::{convert_select_to_query_plan, init_testing_logger, utils::LogicalPlanTestUtils},
    DatabaseProtocol,
};

#[tokio::test]
async fn test_filter_date_greated_and_not_null() {
    if !Rewriter::sql_push_down_enabled() {
        return;
    }
    init_testing_logger();

    let query_plan = convert_select_to_query_plan(
        // language=PostgreSQL
        r#"
SELECT
    dim_str0
FROM MultiTypeCube
WHERE
      (dim_date0 IS NOT NULL)
  AND (dim_date0 > '2019-01-01 00:00:00')
GROUP BY
    dim_str0
;
"#
        .to_string(),
        DatabaseProtocol::PostgreSQL,
    )
    .await;

    let logical_plan = query_plan.as_logical_plan();
    assert_eq!(
        logical_plan.find_cube_scan().request,
        V1LoadRequestQuery {
            measures: Some(vec![]),
            dimensions: Some(vec!["MultiTypeCube.dim_str0".to_string()]),
            segments: Some(vec![]),
            order: Some(vec![]),
            filters: Some(vec![
                V1LoadRequestQueryFilterItem {
                    member: Some("MultiTypeCube.dim_date0".to_string()),
                    operator: Some("set".to_string()),
                    values: None,
                    or: None,
                    and: None,
                },
                V1LoadRequestQueryFilterItem {
                    member: Some("MultiTypeCube.dim_date0".to_string()),
                    operator: Some("afterDate".to_string()),
                    values: Some(vec!["2019-01-01T00:00:00.000Z".to_string()]),
                    or: None,
                    and: None,
                },
            ],),
            ..Default::default()
        }
    );
}

#[tokio::test]
async fn test_filter_dim_in_null() {
    if !Rewriter::sql_push_down_enabled() {
        return;
    }
    init_testing_logger();

    let query_plan = convert_select_to_query_plan(
        // language=PostgreSQL
        r#"
        SELECT
            dim_str0
        FROM
            MultiTypeCube
        WHERE dim_str1 IN (NULL)
        "#
        .to_string(),
        DatabaseProtocol::PostgreSQL,
    )
    .await;

    let physical_plan = query_plan.as_physical_plan().await.unwrap();
    println!(
        "Physical plan: {}",
        displayable(physical_plan.as_ref()).indent()
    );

    // For now this tests only that query is rewritable
    // TODO support this as "notSet" filter

    assert!(query_plan
        .as_logical_plan()
        .find_cube_scan_wrapped_sql()
        .wrapped_sql
        .sql
        .contains(r#"\"sql\":\"${MultiTypeCube.dim_str1} IN (NULL)\""#));
}

#[tokio::test]
async fn test_filter_superset_is_null() {
    if !Rewriter::sql_push_down_enabled() {
        return;
    }
    init_testing_logger();

    let query_plan = convert_select_to_query_plan(
        // language=PostgreSQL
        r#"
SELECT dim_str0 FROM MultiTypeCube WHERE (dim_str1 IS NULL OR dim_str1 IN (NULL) AND (1<>1))
        "#
        .to_string(),
        DatabaseProtocol::PostgreSQL,
    )
    .await;

    let physical_plan = query_plan.as_physical_plan().await.unwrap();
    println!(
        "Physical plan: {}",
        displayable(physical_plan.as_ref()).indent()
    );

    // For now this tests only that query is rewritable
    // TODO support this as "notSet" filter

    assert!(query_plan
        .as_logical_plan()
        .find_cube_scan_wrapped_sql()
        .wrapped_sql
        .sql
        .contains(r#"\"sql\":\"((${MultiTypeCube.dim_str1} IS NULL) OR (${MultiTypeCube.dim_str1} IN (NULL) AND FALSE))\""#));
}

/// Single filter in CubeScan does not support both measuser in dimensions, so it should not get pushed to CubeScan
#[tokio::test]
async fn test_mixed_filters() {
    if !Rewriter::sql_push_down_enabled() {
        return;
    }
    init_testing_logger();

    let query_plan = convert_select_to_query_plan(
        // language=PostgreSQL
        r#"
SELECT
    dim_str0,
    avgPrice
FROM (
    SELECT
        dim_str0,
        AVG(avgPrice) AS avgPrice
    FROM
        MultiTypeCube
    GROUP BY 1
) t
WHERE
    avgPrice > 1
    OR (
        avgPrice = 1
        AND
        dim_str0 = 'completed'
    )
;
        "#
        .to_string(),
        DatabaseProtocol::PostgreSQL,
    )
    .await;

    let physical_plan = query_plan.as_physical_plan().await.unwrap();
    println!(
        "Physical plan: {}",
        displayable(physical_plan.as_ref()).indent()
    );

    let logical_plan = query_plan.as_logical_plan();
    assert_eq!(
        logical_plan.find_cube_scan().request,
        V1LoadRequestQuery {
            measures: Some(vec!["MultiTypeCube.avgPrice".to_string()]),
            dimensions: Some(vec!["MultiTypeCube.dim_str0".to_string()]),
            segments: Some(vec![]),
            order: Some(vec![]),
            filters: None,
            ..Default::default()
        }
    );
}

/// HAVING on a measure combined with ORDER BY on the same measure used to leave
/// a raw `measure()` aggregate in the Sort above the rewritten CubeScan
/// ("Physical plan does not support logical expression measure(...)").
#[tokio::test]
async fn test_measure_having_and_order_by_measure() {
    if !Rewriter::sql_push_down_enabled() {
        return;
    }
    init_testing_logger();

    let query_plan = convert_select_to_query_plan(
        // language=PostgreSQL
        r#"
SELECT
    customer_gender,
    notes,
    DATE_TRUNC('month', order_date) AS order_date_month,
    MEASURE(sumPrice)
FROM KibanaSampleDataEcommerce
WHERE
    order_date >= '2026-01-01'
    AND order_date <= '2026-06-26'
    AND customer_gender IN ('male', 'female')
GROUP BY 1, 2, 3
HAVING
    MEASURE(sumPrice) IS NOT NULL
    AND MEASURE(sumPrice) != 0
ORDER BY MEASURE(sumPrice) DESC
LIMIT 5000
;
"#
        .to_string(),
        DatabaseProtocol::PostgreSQL,
    )
    .await;

    // The whole query must be pushed to a single CubeScan; before the fix
    // physical planning failed on the leftover Sort node.
    let physical_plan = query_plan.as_physical_plan().await.unwrap();
    println!(
        "Physical plan: {}",
        displayable(physical_plan.as_ref()).indent()
    );

    assert_eq!(
        query_plan.as_logical_plan().find_cube_scan().request,
        V1LoadRequestQuery {
            measures: Some(vec!["KibanaSampleDataEcommerce.sumPrice".to_string()]),
            dimensions: Some(vec![
                "KibanaSampleDataEcommerce.customer_gender".to_string(),
                "KibanaSampleDataEcommerce.notes".to_string(),
            ]),
            segments: Some(vec![]),
            time_dimensions: Some(vec![V1LoadRequestQueryTimeDimension {
                dimension: "KibanaSampleDataEcommerce.order_date".to_string(),
                granularity: Some("month".to_string()),
                date_range: Some(serde_json::json!(vec![
                    "2026-01-01T00:00:00.000Z".to_string(),
                    "2026-06-26T00:00:00.000Z".to_string(),
                ])),
            }]),
            order: Some(vec![vec![
                "KibanaSampleDataEcommerce.sumPrice".to_string(),
                "desc".to_string(),
            ]]),
            limit: Some(5000),
            filters: Some(vec![
                V1LoadRequestQueryFilterItem {
                    member: Some("KibanaSampleDataEcommerce.customer_gender".to_string()),
                    operator: Some("equals".to_string()),
                    values: Some(vec!["male".to_string(), "female".to_string()]),
                    or: None,
                    and: None,
                },
                V1LoadRequestQueryFilterItem {
                    member: Some("KibanaSampleDataEcommerce.sumPrice".to_string()),
                    operator: Some("set".to_string()),
                    values: None,
                    or: None,
                    and: None,
                },
                V1LoadRequestQueryFilterItem {
                    member: Some("KibanaSampleDataEcommerce.sumPrice".to_string()),
                    operator: Some("notEquals".to_string()),
                    values: Some(vec!["0".to_string()]),
                    or: None,
                    and: None,
                },
                // The inequality's NULL guard stays with its own predicate,
                // independently of the preceding explicit IS NOT NULL.
                V1LoadRequestQueryFilterItem {
                    member: Some("KibanaSampleDataEcommerce.sumPrice".to_string()),
                    operator: Some("set".to_string()),
                    values: None,
                    or: None,
                    and: None,
                },
            ]),
            ..Default::default()
        }
    );
}

/// SQL inequality must not inherit public Cube notEquals' NULL-inclusive policy.
/// Evaluate the actual emitted Boolean tree to catch guards hoisted across OR.
#[tokio::test]
async fn test_sql_not_equal_preserves_null_rejection_and_branch_locality() {
    fn matches(
        filter: &V1LoadRequestQueryFilterItem,
        gender: Option<&str>,
        price: Option<&str>,
    ) -> bool {
        if let Some(children) = &filter.and {
            return children.iter().all(|child| {
                matches(
                    &serde_json::from_value(child.clone()).unwrap(),
                    gender,
                    price,
                )
            });
        }
        if let Some(children) = &filter.or {
            return children.iter().any(|child| {
                matches(
                    &serde_json::from_value(child.clone()).unwrap(),
                    gender,
                    price,
                )
            });
        }
        let value = match filter.member.as_deref().unwrap() {
            "KibanaSampleDataEcommerce.customer_gender" => gender,
            "KibanaSampleDataEcommerce.taxful_total_price" => price,
            member => panic!("unexpected member {}", member),
        };
        match filter.operator.as_deref().unwrap() {
            "set" => value.is_some(),
            "notSet" => value.is_none(),
            "equals" => value.is_some_and(|value| {
                filter
                    .values
                    .as_ref()
                    .unwrap()
                    .iter()
                    .any(|item| item == value)
            }),
            // This is the existing public JSON behavior: NULL is included.
            "notEquals" => value.is_none_or(|value| {
                filter
                    .values
                    .as_ref()
                    .unwrap()
                    .iter()
                    .all(|item| item != value)
            }),
            operator => panic!("unexpected operator {}", operator),
        }
    }
    init_testing_logger();
    let cases = [
        ("customer_gender <> 'female'", vec![false, false, true, true]),
        ("customer_gender != 'female'", vec![false, false, true, true]),
        ("taxful_total_price <> 2", vec![false, false, true, true]),
        ("taxful_total_price != 2", vec![false, false, true, true]),
        ("customer_gender <> 'female' OR customer_gender IS NULL", vec![true, false, true, true]),
        ("(customer_gender <> 'female' AND taxful_total_price = 1) OR taxful_total_price = 2", vec![false, true, true, false]),
        ("customer_gender = 'female' OR (customer_gender <> 'female' AND taxful_total_price = 1)", vec![false, true, true, false]),
        ("customer_gender = 'female'", vec![false, true, false, false]),
    ];
    let rows = [
        (None, None),
        (Some("female"), Some("2")),
        (Some("male"), Some("1")),
        (Some("male"), Some("3")),
    ];
    for (predicate, expected) in cases {
        let plan = convert_select_to_query_plan(
            format!("SELECT customer_gender FROM KibanaSampleDataEcommerce WHERE {predicate} GROUP BY 1"),
            DatabaseProtocol::PostgreSQL,
        ).await;
        let request = &plan.as_logical_plan().find_cube_scan().request;
        let filters = request.filters.as_ref().expect("semantic filters");
        assert!(!filters.is_empty(), "{}", predicate);
        let actual: Vec<_> = rows
            .iter()
            .map(|(gender, price)| {
                filters
                    .iter()
                    .all(|filter| matches(filter, *gender, *price))
            })
            .collect();
        assert_eq!(actual, expected, "{}: {:?}", predicate, filters);
    }
}

/// A SQL strict bound must reach the source as the same comparator, not an
/// inclusive timeDimension dateRange shifted by an assumed timestamp quantum.
#[tokio::test]
async fn test_strict_date_pair_keeps_native_predicate_bounds() {
    init_testing_logger();
    fn matches(filter: &V1LoadRequestQueryFilterItem, row: Option<chrono::NaiveDateTime>) -> bool {
        if let Some(children) = &filter.and {
            return children
                .iter()
                .all(|child| matches(&serde_json::from_value(child.clone()).unwrap(), row));
        }
        assert!(filter.or.is_none(), "original AND cannot become OR");
        let Some(row) = row else {
            return false;
        };
        assert_eq!(
            filter.member.as_deref(),
            Some("KibanaSampleDataEcommerce.order_date")
        );
        let bound =
            crate::compile::date_parser::parse_date_str(&filter.values.as_ref().unwrap()[0])
                .unwrap();
        match filter.operator.as_deref().unwrap() {
            "afterOrOnDate" => row >= bound,
            "afterDate" => row > bound,
            "beforeOrOnDate" => row <= bound,
            "beforeDate" => row < bound,
            operator => panic!("unexpected date operator {}", operator),
        }
    }
    let rows = [
        Some("2024-05-15T00:00:00"),
        Some("2024-05-15T00:00:00.000500"),
        Some("2024-06-30T23:59:59.999500"),
        Some("2024-07-01T00:00:00"),
        None,
    ]
    .map(|value| value.map(|value| crate::compile::date_parser::parse_date_str(value).unwrap()));
    for (lower_op, upper_op, lower_filter, upper_filter, expected) in [
        (
            ">=",
            "<",
            "afterOrOnDate",
            "beforeDate",
            [true, true, true, false, false],
        ),
        (
            ">",
            "<=",
            "afterDate",
            "beforeOrOnDate",
            [false, true, true, true, false],
        ),
        (
            ">",
            "<",
            "afterDate",
            "beforeDate",
            [false, true, true, false, false],
        ),
    ] {
        for reversed in [false, true] {
            let lower = format!("order_date {lower_op} '2024-05-15T00:00:00'");
            let upper = format!("order_date {upper_op} '2024-07-01T00:00:00'");
            let predicate = if reversed {
                format!("({upper} AND {lower})")
            } else {
                format!("({lower} AND {upper})")
            };
            let query_plan = convert_select_to_query_plan(
                format!(
                    "SELECT DATE_TRUNC('month', order_date) AS month, MEASURE(sumPrice) \
                    FROM KibanaSampleDataEcommerce WHERE {predicate} GROUP BY 1"
                ),
                DatabaseProtocol::PostgreSQL,
            )
            .await;
            let request = query_plan.as_logical_plan().find_cube_scan().request;
            assert_eq!(
                request.measures,
                Some(vec!["KibanaSampleDataEcommerce.sumPrice".to_string()])
            );
            assert_eq!(
                request.time_dimensions,
                Some(vec![V1LoadRequestQueryTimeDimension {
                    dimension: "KibanaSampleDataEcommerce.order_date".to_string(),
                    granularity: Some("month".to_string()),
                    date_range: None,
                }])
            );
            let filters = request.filters.unwrap();
            let actual = rows.map(|row| filters.iter().all(|filter| matches(filter, row)));
            assert_eq!(actual, expected, "{predicate}: {filters:?}");
            assert_eq!(filters.len(), 2, "strict forest: {filters:?}");
            for (operator, value) in [
                (lower_filter, "2024-05-15T00:00:00.000Z"),
                (upper_filter, "2024-07-01T00:00:00.000Z"),
            ] {
                assert_eq!(
                    filters
                        .iter()
                        .filter(|filter| {
                            filter.member.as_deref() == Some("KibanaSampleDataEcommerce.order_date")
                                && filter.operator.as_deref() == Some(operator)
                                && filter.values.as_ref() == Some(&vec![value.to_string()])
                                && filter.and.is_none()
                                && filter.or.is_none()
                        })
                        .count(),
                    1,
                    "original comparator {operator}: {filters:?}"
                );
            }
        }
    }
}

#[tokio::test]
async fn test_inclusive_date_pair_keeps_existing_time_dimension_range() {
    init_testing_logger();
    for reversed in [false, true] {
        let lower = "order_date >= '2024-05-15T00:00:00'";
        let upper = "order_date <= '2024-07-01T00:00:00'";
        let predicate = if reversed {
            format!("({upper} AND {lower})")
        } else {
            format!("({lower} AND {upper})")
        };
        let query_plan = convert_select_to_query_plan(
            format!(
                "SELECT DATE_TRUNC('month', order_date) AS month, MEASURE(sumPrice) \
                FROM KibanaSampleDataEcommerce WHERE {predicate} GROUP BY 1"
            ),
            DatabaseProtocol::PostgreSQL,
        )
        .await;
        let request = query_plan.as_logical_plan().find_cube_scan().request;
        assert_eq!(
            request.time_dimensions,
            Some(vec![V1LoadRequestQueryTimeDimension {
                dimension: "KibanaSampleDataEcommerce.order_date".to_string(),
                granularity: Some("month".to_string()),
                date_range: Some(serde_json::json!([
                    "2024-05-15T00:00:00.000Z",
                    "2024-07-01T00:00:00.000Z"
                ])),
            }])
        );
        assert!(request.filters.as_ref().is_none_or(Vec::is_empty));
    }
}
