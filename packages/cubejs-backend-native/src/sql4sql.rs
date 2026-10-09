use std::sync::Arc;

use neon::prelude::*;

use cubesql::compile::datafusion::logical_plan::LogicalPlan;
use cubesql::compile::datafusion::scalar::ScalarValue;
use cubesql::compile::datafusion::variable::VarType;
use cubesql::compile::engine::df::scan::CubeScanNode;
use cubesql::compile::engine::df::wrapper::{CubeScanWrappedSqlNode, CubeScanWrapperNode};
use cubesql::compile::{convert_sql_to_cube_query, DatabaseVariable};
use cubesql::sql::{Session, CUBESQL_PENALIZE_POST_PROCESSING_VAR};
use cubesql::transport::MetaContext;
use cubesql::CubeError;

use crate::auth::NativeSQLAuthContext;
use crate::config::NodeCubeServices;
use crate::cubesql_utils::with_session;
use crate::tokio_runtime_node;
use crate::utils::NonDebugInRelease;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sql4SqlQueryType {
    Regular,
    PostProcessing,
    Pushdown,
}

impl Sql4SqlQueryType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::PostProcessing => "post_processing",
            Self::Pushdown => "pushdown",
        }
    }

    pub fn to_js<'ctx>(&self, cx: &mut impl Context<'ctx>) -> JsResult<'ctx, JsString> {
        Ok(cx.string(self.as_str()))
    }
}

/// Native root-plan classification shared with SQL translation. No SQL text,
/// freshness, pre-aggregation or application wrapper participates in it.
pub(crate) fn classify_query_type(plan: &LogicalPlan) -> Option<Sql4SqlQueryType> {
    match plan {
        LogicalPlan::Extension(extension) => {
            if extension.node.as_any().is::<CubeScanWrappedSqlNode>() {
                Some(Sql4SqlQueryType::Pushdown)
            } else if extension.node.as_any().is::<CubeScanNode>() {
                Some(Sql4SqlQueryType::Regular)
            } else {
                None
            }
        }
        _ => Some(Sql4SqlQueryType::PostProcessing),
    }
}

/// Called only after get_df_batches has initialized this exact executed plan.
/// Non-SELECT and unrecognized extension roots carry no tier claim.
pub(crate) fn append_executed_query_type(
    schema: &mut serde_json::Map<String, serde_json::Value>,
    query_plan: &cubesql::compile::QueryPlan,
) {
    if let cubesql::compile::QueryPlan::DataFusionSelect(plan, _) = query_plan {
        if let Some(query_type) = classify_query_type(plan) {
            schema.insert("query_type".into(), query_type.as_str().into());
        }
    }
}

enum Sql4SqlResponseResult {
    Ok {
        sql: String,
        values: Vec<Option<String>>,
    },
    Error {
        error: String,
    },
}

struct Sql4SqlResponse {
    result: Sql4SqlResponseResult,
    query_type: Sql4SqlQueryType,
}

impl Sql4SqlResponse {
    pub fn to_js<'ctx>(&self, cx: &mut impl Context<'ctx>) -> JsResult<'ctx, JsObject> {
        let obj = cx.empty_object();

        match &self.result {
            Sql4SqlResponseResult::Ok { sql, values } => {
                let status = cx.string("ok");
                obj.set(cx, "status", status)?;

                let sql_tuple = cx.empty_array();
                let sql = cx.string(sql);
                sql_tuple.set(cx, 0, sql)?;
                let js_values = cx.empty_array();
                for (i, v) in values.iter().enumerate() {
                    use std::convert::TryFrom;
                    let i = u32::try_from(i).unwrap();
                    let v: Handle<JsValue> = v
                        .as_ref()
                        .map(|v| cx.string(v).upcast())
                        .unwrap_or_else(|| cx.null().upcast());
                    js_values.set(cx, i, v)?;
                }
                sql_tuple.set(cx, 1, js_values)?;
                obj.set(cx, "sql", sql_tuple)?;
            }
            Sql4SqlResponseResult::Error { error } => {
                let status = cx.string("error");
                obj.set(cx, "status", status)?;

                let error = cx.string(error);
                obj.set(cx, "error", error)?;
            }
        }

        let query_type = self.query_type.to_js(cx)?;
        obj.set(cx, "query_type", query_type)?;

        Ok(obj)
    }
}

async fn get_sql(
    session: &Session,
    meta_context: Arc<MetaContext>,
    plan: Arc<LogicalPlan>,
) -> Result<Sql4SqlResponse, CubeError> {
    let auth_context = session
        .state
        .auth_context()
        .ok_or_else(|| CubeError::internal("Unexpected missing auth context".to_string()))?;

    let query_type = classify_query_type(plan.as_ref()).ok_or_else(|| {
        CubeError::internal("Unexpected extension in logical plan root".to_string())
    })?;

    match plan.as_ref() {
        LogicalPlan::Extension(extension) => {
            let cube_scan_wrapped_sql = extension
                .node
                .as_any()
                .downcast_ref::<CubeScanWrappedSqlNode>();

            if let Some(cube_scan_wrapped_sql) = cube_scan_wrapped_sql {
                return Ok(Sql4SqlResponse {
                    result: Sql4SqlResponseResult::Ok {
                        sql: cube_scan_wrapped_sql.wrapped_sql.sql.clone(),
                        values: cube_scan_wrapped_sql.wrapped_sql.values.clone(),
                    },
                    query_type,
                });
            }

            if extension.node.as_any().is::<CubeScanNode>() {
                let cube_scan_wrapper = CubeScanWrapperNode::new(
                    plan,
                    meta_context,
                    auth_context,
                    None,
                    session.server.config_obj.clone(),
                );
                let wrapped_sql = cube_scan_wrapper
                    .generate_sql(
                        session.server.transport.clone(),
                        Arc::new(session.state.get_load_request_meta("sql")),
                        Arc::clone(&session.state),
                    )
                    .await?;

                return Ok(Sql4SqlResponse {
                    result: Sql4SqlResponseResult::Ok {
                        sql: wrapped_sql.wrapped_sql.sql.clone(),
                        values: wrapped_sql.wrapped_sql.values.clone(),
                    },
                    query_type,
                });
            }

            Err(CubeError::internal(
                "Unexpected extension in logical plan root".to_string(),
            ))
        }
        _ => Ok(Sql4SqlResponse {
            result: Sql4SqlResponseResult::Error {
                error: "Provided query can not be executed without post-processing.".to_string(),
            },
            query_type,
        }),
    }
}

async fn handle_sql4sql_query(
    services: Arc<NodeCubeServices>,
    native_auth_ctx: Arc<NativeSQLAuthContext>,
    sql_query: &str,
    disable_post_processing: bool,
) -> Result<Sql4SqlResponse, CubeError> {
    with_session(&services, native_auth_ctx.clone(), |session| async move {
        if disable_post_processing {
            let v = DatabaseVariable {
                name: CUBESQL_PENALIZE_POST_PROCESSING_VAR.to_string(),
                value: ScalarValue::Boolean(Some(true)),
                var_type: VarType::UserDefined,
                readonly: false,
                additional_params: None,
            };
            session.state.set_variables(vec![v]);
        }

        let transport = session.server.transport.clone();
        // todo: can we use compiler_cache?
        let meta_context = transport.meta(native_auth_ctx).await?;
        let query_plan =
            convert_sql_to_cube_query(sql_query, meta_context.clone(), session.clone()).await?;
        let logical_plan = query_plan.try_as_logical_plan()?;
        get_sql(&session, meta_context, Arc::new(logical_plan.clone())).await
    })
    .await
}

pub fn sql4sql(mut cx: FunctionContext) -> JsResult<JsValue> {
    let interface = cx.argument::<JsBox<crate::node_export::SQLInterface>>(0)?;
    let sql_query = cx.argument::<JsString>(1)?.value(&mut cx);
    let disable_post_processing = cx.argument::<JsBoolean>(2)?.value(&mut cx);

    let security_context: Option<serde_json::Value> = match cx.argument::<JsValue>(3) {
        Ok(string) => match string.downcast::<JsString, _>(&mut cx) {
            Ok(v) => v.value(&mut cx).parse::<serde_json::Value>().ok(),
            Err(_) => None,
        },
        Err(_) => None,
    };

    let services = interface.services(&mut cx)?;
    let runtime = tokio_runtime_node(&mut cx)?;

    let channel = cx.channel();

    let native_auth_ctx = Arc::new(NativeSQLAuthContext {
        user: Some(String::from("unknown")),
        superuser: false,
        security_context: NonDebugInRelease::from(security_context),
    });

    let (deferred, promise) = cx.promise();

    // In case spawned task panics or gets aborted before settle call it will leave permanently pending Promise in JS land
    // We don't want to just waste whole thread (doesn't really matter main or worker or libuv thread pool)
    // just busy waiting that JoinHandle
    // TODO handle JoinError
    //  keep JoinHandle alive in JS thread
    //  check join handle from JS thread periodically, reject promise on JoinError
    //  maybe register something like uv_check handle (libuv itself does not have ABI stability of N-API)
    //  can do it relatively rare, and in a single loop for all JoinHandles
    //  this is just a watchdog for a Very Bad case, so latency requirement can be quite relaxed
    runtime.spawn(async move {
        let result = handle_sql4sql_query(
            services,
            native_auth_ctx,
            &sql_query,
            disable_post_processing,
        )
        .await;

        if let Err(err) = deferred.try_settle_with(&channel, move |mut cx| {
            // `neon::result::ResultExt` is implemented only for Result<Handle, Handle>, even though Ok variant is not touched
            let response = result.or_else(|err| cx.throw_error(err.to_string()))?;
            let response = response.to_js(&mut cx)?;
            Ok(response)
        }) {
            // There is not much we can do at this point
            // TODO lift this error to task => JoinHandle => JS watchdog
            log::error!(
                "Unable to settle JS promise from tokio task, try_settle_with failed, err: {err}"
            );
        }
    });

    Ok(promise.upcast::<JsValue>())
}

#[cfg(test)]
mod executed_query_type_tests {
    use super::*;
    use cubesql::compile::datafusion::{
        execution::context::SessionContext,
        logical_plan::{
            plan::{Extension, Limit},
            DFSchema, Expr, UserDefinedLogicalNode,
        },
    };
    use cubesql::compile::engine::df::{scan::CubeScanOptions, wrapper::SqlQuery};
    use cubesql::compile::{CommandCompletion, QueryPlan, StatusFlags};
    use cubesql::transport::TransportLoadRequestQuery;
    use std::{any::Any, fmt};

    fn regular_root() -> LogicalPlan {
        LogicalPlan::Extension(Extension {
            node: Arc::new(CubeScanNode::new(
                Arc::new(DFSchema::empty()),
                vec![],
                TransportLoadRequestQuery::default(),
                Arc::new(NativeSQLAuthContext {
                    user: None,
                    superuser: false,
                    security_context: NonDebugInRelease::from(None),
                }),
                CubeScanOptions {
                    sql_order_nulls_first: vec![],
                    change_user: None,
                    max_records: None,
                    cache_mode: None,
                    throw_continue_wait: false,
                },
                vec![],
                None,
            )),
        })
    }
    fn schema_for(plan: LogicalPlan) -> serde_json::Value {
        let plan = QueryPlan::DataFusionSelect(plan, SessionContext::new());
        let mut schema = serde_json::Map::new();
        schema.insert(
            "schema".into(),
            serde_json::json!([{ "name": "n", "column_type": "Int64" }]),
        );
        append_executed_query_type(&mut schema, &plan);
        serde_json::Value::Object(schema)
    }

    #[test]
    fn emitted_metadata_classifies_actual_typed_select_root_and_preserves_schema() {
        let regular = schema_for(regular_root());
        assert_eq!(regular["query_type"], "regular");
        assert_eq!(regular["schema"][0]["name"], "n");
        let wrapped = LogicalPlan::Extension(Extension {
            node: Arc::new(CubeScanWrappedSqlNode::new(
                Arc::new(regular_root()),
                // Deliberately misleading prose cannot affect typed-plan classification.
                SqlQuery::new("SELECT 'post_processing regular'".to_string(), vec![]),
                TransportLoadRequestQuery::default(),
                vec![],
            )),
        });
        assert_eq!(schema_for(wrapped)["query_type"], "pushdown");
        let residual = LogicalPlan::Limit(Limit {
            skip: Some(0),
            fetch: Some(1),
            input: Arc::new(regular_root()),
        });
        assert_eq!(schema_for(residual)["query_type"], "post_processing");
    }

    #[derive(Debug)]
    struct UnrecognizedRoot {
        schema: Arc<DFSchema>,
    }
    impl UserDefinedLogicalNode for UnrecognizedRoot {
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn inputs(&self) -> Vec<&LogicalPlan> {
            vec![]
        }
        fn schema(&self) -> &Arc<DFSchema> {
            &self.schema
        }
        fn expressions(&self) -> Vec<Expr> {
            vec![]
        }
        fn fmt_for_explain(&self, f: &mut fmt::Formatter) -> fmt::Result {
            write!(f, "Unknown")
        }
        fn from_template(
            &self,
            _exprs: &[Expr],
            _inputs: &[LogicalPlan],
        ) -> Arc<dyn UserDefinedLogicalNode + Send + Sync> {
            Arc::new(Self {
                schema: self.schema.clone(),
            })
        }
    }
    #[test]
    fn unrecognized_or_non_select_plan_does_not_emit_a_default_tier() {
        let unknown = LogicalPlan::Extension(Extension {
            node: Arc::new(UnrecognizedRoot {
                schema: Arc::new(DFSchema::empty()),
            }),
        });
        assert!(schema_for(unknown).get("query_type").is_none());
        let mut schema = serde_json::Map::new();
        append_executed_query_type(
            &mut schema,
            &QueryPlan::MetaOk(StatusFlags::empty(), CommandCompletion::Set),
        );
        assert!(!schema.contains_key("query_type"));
    }
}
