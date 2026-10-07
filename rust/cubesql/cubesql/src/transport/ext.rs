use datafusion::arrow::datatypes::{DataType, TimeUnit};

use crate::{
    sql::ColumnType,
    transport::{CubeMeta, CubeMetaDimension, CubeMetaMeasure, CubeMetaSegment},
    CubeError,
};

/// A member result contract, not its input storage type. In particular SUM may
/// widen an integer input to Decimal and AVG may change its scale.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum NumericResultDeclaration {
    #[serde(rename = "decimal")]
    Decimal {
        precision: usize,
        scale: usize,
        arithmetic: String,
    },
    #[serde(rename = "integer")]
    Integer {
        bits: u8,
        signed: bool,
        arithmetic: String,
    },
}

pub(super) fn numeric_result_type(
    member: &str,
    member_type: &str,
    meta: Option<&serde_json::Value>,
) -> Result<Option<ColumnType>, CubeError> {
    let Some(semantics) = meta.and_then(|meta| meta.get("result_semantics")) else {
        return Ok(None);
    };
    // Existing unknown result semantics need not have a numeric declaration.
    let Some(numeric) = semantics.get("numeric") else {
        return Ok(None);
    };
    let invalid = || {
        CubeError::user(format!(
            "Invalid exact numeric result declaration for {}",
            member
        ))
    };
    if !member_type.eq_ignore_ascii_case("number") {
        return Err(invalid());
    }
    let declaration: NumericResultDeclaration =
        serde_json::from_value(numeric.clone()).map_err(|_| invalid())?;
    match declaration {
        NumericResultDeclaration::Decimal {
            precision,
            scale,
            arithmetic,
        } if arithmetic == "exact" && (1..=38).contains(&precision) && scale <= precision => {
            Ok(Some(ColumnType::Decimal(precision, scale)))
        }
        NumericResultDeclaration::Integer {
            bits: 64,
            signed: true,
            arithmetic,
        } if arithmetic == "exact" => Ok(Some(ColumnType::Int64)),
        _ => Err(invalid()),
    }
}

pub trait V1CubeMetaMeasureExt {
    fn get_real_name(&self) -> String;

    fn is_same_agg_type(&self, expect_agg_type: &str, disable_strict_match: bool) -> bool;

    fn allow_replace_agg_type(&self, query_agg_type: &str, disable_strict_match: bool) -> bool;

    fn allow_add_filter(&self, query_agg_type: Option<&str>) -> bool;

    fn get_sql_type(&self) -> ColumnType;
}

impl V1CubeMetaMeasureExt for CubeMetaMeasure {
    fn get_real_name(&self) -> String {
        let (_, dimension_name) = self.name.split_once('.').unwrap();

        dimension_name.to_string()
    }

    fn is_same_agg_type(&self, expect_agg_type: &str, disable_strict_match: bool) -> bool {
        if disable_strict_match {
            return true;
        }
        let Some(agg_type) = &self.agg_type else {
            return false;
        };
        match expect_agg_type {
            "countDistinct" => {
                agg_type == "countDistinct"
                    || agg_type == "countDistinctApprox"
                    || agg_type == "number"
            }
            "sum" => agg_type == "sum" || agg_type == "count" || agg_type == "number",
            "min" | "max" => {
                agg_type == "number"
                    || agg_type == "string"
                    || agg_type == "time"
                    || agg_type == "boolean"
                    || agg_type == expect_agg_type
            }
            _ => agg_type == "number" || agg_type == expect_agg_type,
        }
    }

    // This should be aligned with BaseMeasure.preparePatchedMeasure
    // See packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts:16
    fn allow_replace_agg_type(&self, query_agg_type: &str, disable_strict_match: bool) -> bool {
        if disable_strict_match {
            return true;
        }
        let Some(agg_type) = &self.agg_type else {
            return false;
        };

        match (agg_type.as_str(), query_agg_type) {
            (
                "sum" | "avg" | "min" | "max",
                "sum" | "avg" | "min" | "max" | "count_distinct" | "count_distinct_approx",
            ) => true,

            (
                "count_distinct" | "count_distinct_approx",
                "count_distinct" | "count_distinct_approx",
            ) => true,

            _ => false,
        }
    }

    // This should be aligned with BaseMeasure.preparePatchedMeasure
    // See packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts:16
    fn allow_add_filter(&self, query_agg_type: Option<&str>) -> bool {
        let Some(agg_type) = &self.agg_type else {
            return false;
        };

        let agg_type = match query_agg_type {
            Some(query_agg_type) => query_agg_type,
            None => agg_type,
        };

        match agg_type {
            "sum"
            | "avg"
            | "min"
            | "max"
            | "count"
            | "count_distinct"
            | "countDistinct"
            | "count_distinct_approx"
            | "countDistinctApprox" => true,
            _ => false,
        }
    }

    fn get_sql_type(&self) -> ColumnType {
        // MetaContext validates all declarations before constructing any schema.
        if let Some(declared) = numeric_result_type(&self.name, &self.r#type, self.meta.as_ref())
            .expect("numeric result metadata must be validated before schema construction")
        {
            return declared;
        }
        let from_type = match &self.r#type.to_lowercase().as_str() {
            &"number" => ColumnType::Double,
            &"boolean" => ColumnType::Boolean,
            _ => ColumnType::String,
        };

        match &self.agg_type {
            Some(agg_type) => match agg_type.as_str() {
                "count" => ColumnType::Int64,
                "countDistinct" => ColumnType::Int64,
                "countDistinctApprox" => ColumnType::Int64,
                "sum" => ColumnType::Double,
                "avg" => ColumnType::Double,
                "min" => ColumnType::Double,
                "max" => ColumnType::Double,
                _ => from_type,
            },
            _ => from_type,
        }
    }
}

pub trait V1CubeMetaSegmentExt {
    fn get_real_name(&self) -> String;
}

impl V1CubeMetaSegmentExt for CubeMetaSegment {
    fn get_real_name(&self) -> String {
        let (_, segment_name) = self.name.split_once('.').unwrap();

        segment_name.to_string()
    }
}

pub trait V1CubeMetaDimensionExt {
    fn get_real_name(&self) -> String;

    fn sql_can_be_null(&self) -> bool;

    fn get_sql_type(&self) -> ColumnType;

    fn is_time(&self) -> bool;
}

impl V1CubeMetaDimensionExt for CubeMetaDimension {
    fn get_real_name(&self) -> String {
        let (_, dimension_name) = self.name.split_once('.').unwrap();

        dimension_name.to_string()
    }

    fn is_time(&self) -> bool {
        self.r#type.to_lowercase().eq("time")
    }

    fn sql_can_be_null(&self) -> bool {
        // @todo Possible not null?
        true
    }

    fn get_sql_type(&self) -> ColumnType {
        if let Some(declared) = numeric_result_type(&self.name, &self.r#type, self.meta.as_ref())
            .expect("numeric result metadata must be validated before schema construction")
        {
            return declared;
        }
        match self.r#type.to_lowercase().as_str() {
            "time" => ColumnType::Timestamp,
            "number" => ColumnType::Double,
            "boolean" => ColumnType::Boolean,
            _ => ColumnType::String,
        }
    }
}

#[derive(Debug)]
pub struct CubeColumn {
    member_name: String,
    name: String,
    description: Option<String>,
    column_type: ColumnType,
    can_be_null: bool,
}

impl CubeColumn {
    pub fn member_name(&self) -> &String {
        &self.member_name
    }

    pub fn get_name(&self) -> &String {
        &self.name
    }

    pub fn get_description(&self) -> &Option<String> {
        &self.description
    }

    pub fn sql_can_be_null(&self) -> bool {
        self.can_be_null
    }

    pub fn get_column_type(&self) -> ColumnType {
        self.column_type.clone()
    }
}

pub trait V1CubeMetaExt {
    fn get_columns(&self) -> Vec<CubeColumn>;

    fn get_scan_columns(&self) -> Vec<CubeColumn>;

    fn contains_member(&self, member_name: &str) -> bool;

    fn member_name(&self, column_name: &str) -> String;

    fn lookup_dimension(&self, column_name: &str) -> Option<&CubeMetaDimension>;

    fn lookup_dimension_by_member_name(&self, member_name: &str) -> Option<&CubeMetaDimension>;

    fn lookup_measure(&self, column_name: &str) -> Option<&CubeMetaMeasure>;

    fn lookup_measure_by_member_name(&self, member_name: &str) -> Option<&CubeMetaMeasure>;

    fn lookup_segment(&self, column_name: &str) -> Option<&CubeMetaSegment>;

    fn df_data_type(&self, member_name: &str) -> Option<DataType>;

    fn member_type(&self, member_name: &str) -> Option<MemberType>;
}

pub enum MemberType {
    String,
    Number,
    Time,
    Boolean,
}

impl V1CubeMetaExt for CubeMeta {
    fn get_columns(&self) -> Vec<CubeColumn> {
        let mut columns = Vec::new();

        for measure in &self.measures {
            columns.push(CubeColumn {
                member_name: measure.name.clone(),
                name: measure.get_real_name(),
                description: measure.description.clone(),
                column_type: measure.get_sql_type(),
                can_be_null: false,
            });
        }

        for dimension in &self.dimensions {
            columns.push(CubeColumn {
                member_name: dimension.name.clone(),
                name: dimension.get_real_name(),
                description: dimension.description.clone(),
                column_type: dimension.get_sql_type(),
                can_be_null: dimension.sql_can_be_null(),
            });
        }

        for segment in &self.segments {
            columns.push(CubeColumn {
                member_name: segment.name.clone(),
                name: segment.get_real_name(),
                description: segment.description.clone(),
                column_type: ColumnType::Boolean,
                can_be_null: false,
            });
        }

        columns.push(CubeColumn {
            member_name: "__user".to_string(),
            name: "__user".to_string(),
            description: Some("Virtual column for security context switching".to_string()),
            column_type: ColumnType::String,
            can_be_null: true,
        });

        columns.push(CubeColumn {
            member_name: "__cubeJoinField".to_string(),
            name: "__cubeJoinField".to_string(),
            description: Some("Virtual column for joining cubes".to_string()),
            column_type: ColumnType::String,
            can_be_null: true,
        });

        columns
    }

    fn get_scan_columns(&self) -> Vec<CubeColumn> {
        let mut columns = Vec::new();

        for measure in &self.measures {
            columns.push(CubeColumn {
                member_name: measure.name.clone(),
                name: measure.get_real_name(),
                description: None,
                column_type: measure.get_sql_type(),
                can_be_null: false,
            });
        }

        for dimension in &self.dimensions {
            columns.push(CubeColumn {
                member_name: dimension.name.clone(),
                name: dimension.get_real_name(),
                description: None,
                column_type: dimension.get_sql_type(),
                can_be_null: dimension.sql_can_be_null(),
            });
        }

        columns
    }

    fn contains_member(&self, member_name: &str) -> bool {
        self.measures
            .iter()
            .any(|m| m.name.eq_ignore_ascii_case(member_name))
            || self
                .dimensions
                .iter()
                .any(|m| m.name.eq_ignore_ascii_case(member_name))
    }

    fn member_name(&self, column_name: &str) -> String {
        format!("{}.{}", self.name, column_name)
    }

    fn lookup_measure(&self, column_name: &str) -> Option<&CubeMetaMeasure> {
        let member_name = self.member_name(column_name);
        self.lookup_measure_by_member_name(&member_name)
    }

    fn lookup_measure_by_member_name(&self, member_name: &str) -> Option<&CubeMetaMeasure> {
        self.measures
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(&member_name))
    }

    fn lookup_dimension(&self, column_name: &str) -> Option<&CubeMetaDimension> {
        let member_name = self.member_name(column_name);
        self.lookup_dimension_by_member_name(&member_name)
    }

    fn lookup_dimension_by_member_name(&self, member_name: &str) -> Option<&CubeMetaDimension> {
        self.dimensions
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(&member_name))
    }

    fn lookup_segment(&self, column_name: &str) -> Option<&CubeMetaSegment> {
        let member_name = self.member_name(column_name);
        self.segments
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(&member_name))
    }

    fn df_data_type(&self, member_name: &str) -> Option<DataType> {
        if let Some(m) = self
            .measures
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(member_name))
        {
            return Some(df_data_type_by_column_type(m.get_sql_type()));
        }

        if let Some(m) = self
            .dimensions
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(member_name))
        {
            return Some(df_data_type_by_column_type(m.get_sql_type()));
        }

        if let Some(_) = self
            .segments
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(member_name))
        {
            return Some(df_data_type_by_column_type(ColumnType::Int8));
        }
        None
    }

    fn member_type(&self, member_name: &str) -> Option<MemberType> {
        if let Some(_) = self
            .measures
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(member_name))
        {
            return Some(MemberType::Number);
        }

        if let Some(dimension) = self
            .dimensions
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(member_name))
        {
            return Some(match dimension.r#type.as_str() {
                "number" => MemberType::Number,
                "boolean" => MemberType::Boolean,
                "string" => MemberType::String,
                "time" => MemberType::Time,
                x => panic!("Unexpected dimension type: {}", x),
            });
        }

        if let Some(_) = self
            .segments
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(member_name))
        {
            return Some(MemberType::Boolean);
        }
        None
    }
}

pub fn df_data_type_by_column_type(column_type: ColumnType) -> DataType {
    match column_type {
        ColumnType::Int32 | ColumnType::Int64 | ColumnType::Int8 => DataType::Int64,
        ColumnType::String => DataType::Utf8,
        ColumnType::Double => DataType::Float64,
        ColumnType::Decimal(precision, scale) => DataType::Decimal(precision, scale),
        ColumnType::Boolean => DataType::Boolean,
        ColumnType::Timestamp => DataType::Timestamp(TimeUnit::Nanosecond, None),
        _ => panic!("Unimplemented support for {:?}", column_type),
    }
}

#[cfg(test)]
mod numeric_result_tests {
    use super::*;
    use crate::transport::{CubeMetaType, MetaContext};
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn exact_result_types_preserve_aggregate_widening_and_legacy_omission() {
        let mut measure = CubeMetaMeasure::new("Orders.amount".to_string(), "number".to_string());
        measure.agg_type = Some("sum".to_string());
        assert_eq!(measure.get_sql_type(), ColumnType::Double);
        measure.meta = Some(
            json!({"result_semantics":{"numeric":{"kind":"decimal","precision":38,"scale":0,"arithmetic":"exact"}}}),
        );
        assert_eq!(measure.get_sql_type(), ColumnType::Decimal(38, 0));
        assert_eq!(
            df_data_type_by_column_type(measure.get_sql_type()),
            DataType::Decimal(38, 0)
        );
        measure.meta = Some(
            json!({"result_semantics":{"numeric":{"kind":"integer","bits":64,"signed":true,"arithmetic":"exact"}}}),
        );
        assert_eq!(measure.get_sql_type(), ColumnType::Int64);
        let mut dimension = CubeMetaDimension::new("Orders.id".to_string(), "number".to_string());
        dimension.meta = measure.meta.clone();
        assert_eq!(dimension.get_sql_type(), ColumnType::Int64);
    }

    #[test]
    fn invalid_exact_declarations_fail_metadata_construction() {
        let invalids = vec![
            json!(null),
            json!({"kind":"decimal","precision":0,"scale":0,"arithmetic":"exact"}),
            json!({"kind":"decimal","precision":39,"scale":9,"arithmetic":"exact"}),
            json!({"kind":"decimal","precision":3,"scale":4,"arithmetic":"exact"}),
            json!({"kind":"decimal","precision":38,"scale":-1,"arithmetic":"exact"}),
            json!({"kind":"decimal","precision":38,"scale":9,"arithmetic":"approximate"}),
            json!({"kind":"decimal","precision":38,"scale":9,"arithmetic":"exact","bits":64}),
            json!({"kind":"integer","bits":32,"signed":true,"arithmetic":"exact"}),
            json!({"kind":"integer","bits":64,"signed":false,"arithmetic":"exact"}),
            json!({"kind":"integer","bits":64,"signed":true}),
        ];
        for numeric in invalids {
            for member_type in ["number", "string"] {
                let mut measure =
                    CubeMetaMeasure::new("Orders.amount".to_string(), member_type.to_string());
                measure.meta = Some(json!({"result_semantics":{"numeric":numeric}}));
                let cube = CubeMeta {
                    name: "Orders".to_string(),
                    description: None,
                    title: None,
                    r#type: CubeMetaType::Cube,
                    dimensions: vec![],
                    measures: vec![measure],
                    segments: vec![],
                    joins: None,
                    folders: None,
                    nested_folders: None,
                    hierarchies: None,
                    meta: None,
                };
                assert!(MetaContext::new(
                    vec![cube],
                    HashMap::new(),
                    HashMap::new(),
                    uuid::Uuid::new_v4()
                )
                .is_err());
            }
        }
        assert!(numeric_result_type("Orders.amount", "string", Some(&json!({"result_semantics":{"numeric":{"kind":"integer","bits":64,"signed":true,"arithmetic":"exact"}}}))).is_err());
    }
}
