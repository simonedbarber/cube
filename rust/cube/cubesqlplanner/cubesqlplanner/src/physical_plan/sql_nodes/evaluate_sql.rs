use super::SqlNode;
use crate::physical_plan::symbols::{MemberSqlContext, ToSql};
use crate::physical_plan::SqlEvaluatorVisitor;
use crate::planner::query_tools::QueryTools;
use crate::planner::sql_templates::PlanSqlTemplates;
use crate::planner::MemberSymbol;
use cubenativeutils::CubeError;
use std::any::Any;
use std::collections::HashMap;
use std::rc::Rc;

/// Base case of the SQL-node chain: invokes the member symbol's own
/// `to_sql` to produce the raw SQL fragment. All wrapping nodes
/// eventually delegate down to this.
pub struct EvaluateSqlNode {
    cube_references: HashMap<String, String>,
}

impl EvaluateSqlNode {
    pub fn new(cube_references: HashMap<String, String>) -> Rc<Self> {
        Rc::new(Self { cube_references })
    }
}

impl SqlNode for EvaluateSqlNode {
    fn to_sql(
        &self,
        visitor: &SqlEvaluatorVisitor,
        node: &Rc<MemberSymbol>,
        query_tools: Rc<QueryTools>,
        node_processor: Rc<dyn SqlNode>,
        templates: &PlanSqlTemplates,
    ) -> Result<String, CubeError> {
        let path = node.compiled_path();
        let cube_alias = self
            .cube_references
            .get(path.cube_name())
            .unwrap_or(path.cube_name());
        let ctx = MemberSqlContext {
            visitor,
            node_processor: &node_processor,
            query_tools: &query_tools,
            templates,
            name: path.name(),
            full_name: path.full_name(),
            cube_alias,
        };
        node.as_ref().to_sql(&ctx)
    }

    fn as_any(self: Rc<Self>) -> Rc<dyn Any> {
        self.clone()
    }

    fn childs(&self) -> Vec<Rc<dyn SqlNode>> {
        vec![]
    }
}
