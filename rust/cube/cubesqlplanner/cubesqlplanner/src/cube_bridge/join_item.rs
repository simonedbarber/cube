use super::join_item_definition::{JoinItemDefinition, NativeJoinItemDefinition};
use cubenativeutils::wrappers::serializer::{
    NativeDeserialize, NativeDeserializer, NativeSerialize,
};
use cubenativeutils::wrappers::NativeContextHolder;
use cubenativeutils::wrappers::NativeObjectHandle;
use cubenativeutils::CubeError;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::rc::Rc;

#[derive(
    Serialize, Deserialize, Debug, Clone, Eq, PartialEq, Hash, nativebridge::NativeBridgeStatic,
)]
pub struct JoinItemStatic {
    pub from: String,
    pub to: String,
    #[serde(rename = "originalFrom")]
    pub original_from: String,
    #[serde(rename = "originalTo")]
    pub original_to: String,
    // Cube whose `joins:` block declared the underlying join. Used as the SQL cube
    // context for `${CUBE}` resolution inside `join.sql`. For declared edges this
    // equals `original_from`. For synthetic reverse edges (produced by an explicit
    // direction request via `__cubeExplicitJoinField` when the model declared only
    // the opposite direction), `from`/`to`/`original_from`/`original_to` are all
    // swapped while `declared_on` stays pointed at the original declaring cube so
    // the join SQL still compiles correctly.
    //
    // Optional for backwards compatibility with bridges that haven't been updated
    // yet; consumers should fall back to `original_from` when absent.
    #[serde(rename = "declaredOn", default, skip_serializing_if = "Option::is_none")]
    pub declared_on: Option<String>,
}

#[nativebridge::native_bridge(JoinItemStatic, with_static_meta)]
pub trait JoinItem {
    #[nbridge(field)]
    fn join(&self) -> Result<Rc<dyn JoinItemDefinition>, CubeError>;
}
