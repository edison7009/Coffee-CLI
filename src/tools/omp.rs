//! Oh-My-Pi — T2: Pi-format history, heatmap and resume.
//! All live interaction stays in its native terminal UI.
//! Its own store is ~/.omp/agent/sessions/<encoded-cwd>/*.jsonl.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "omp",
    display_name: "Oh-My-Pi",
    binary_name: "omp",
    has_legacy_hook_artifacts: false,
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".omp/agent/sessions",
        depth: 2,
    }),
    default_args: &[],
};
