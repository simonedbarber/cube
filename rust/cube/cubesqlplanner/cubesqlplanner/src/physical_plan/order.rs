use super::Expr;

#[derive(Clone)]
pub struct OrderBy {
    pub expr: Expr,
    pub pos: usize,
    pub desc: bool,
    pub nulls_first: Option<bool>,
}

impl OrderBy {
    pub fn new(expr: Expr, pos: usize, desc: bool) -> OrderBy {
        OrderBy { expr, pos, desc, nulls_first: None }
    }

    pub fn with_nulls_first(mut self, value: Option<bool>) -> Self {
        self.nulls_first = value;
        self
    }

    pub fn asc_str(&self) -> &str {
        if self.desc {
            "DESC"
        } else {
            "ASC"
        }
    }
}
