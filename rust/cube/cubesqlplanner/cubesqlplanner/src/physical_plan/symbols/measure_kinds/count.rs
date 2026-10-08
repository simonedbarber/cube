use super::super::{MemberSqlContext, ToSql};
use crate::physical_plan::sql_nodes::AutoPrefixSqlNode;
use crate::planner::symbols::measure_kinds::{CountMeasure, CountSql};
use cubenativeutils::CubeError;

impl ToSql for CountMeasure {
    fn to_sql(&self, ctx: &MemberSqlContext) -> Result<String, CubeError> {
        match self.sql() {
            CountSql::Explicit(sql) => ctx.eval_sql_call(sql),
            CountSql::Auto(pk_sqls) => {
                if pk_sqls.len() > 1 {
                    let keys = pk_sqls
                        .iter()
                        // Qualify each component before ROW/CASE hides its bare
                        // identifier from the ordinary member-level qualifier.
                        .map(|pk| {
                            AutoPrefixSqlNode::auto_prefix_with_cube_name(
                                ctx.cube_alias,
                                &ctx.eval_sql_call(pk)?,
                                ctx.templates,
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    ctx.templates.composite_key(&keys)
                } else if let Some(pk_sql) = pk_sqls.first() {
                    ctx.eval_sql_call(pk_sql)
                } else {
                    Ok("*".to_string())
                }
            }
        }
    }
}
