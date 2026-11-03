//! Antigravity CLI (Google).
//!
//! Antigravity is closed-source and its private conversation files have changed
//! across releases, so Coffee CLI reads only its own conversation index
//! (`~/.gemini/antigravity-cli/conversation_summaries.db`, in server.rs) for
//! history and heatmap, and resumes with `agy --conversation <id>`. No hook or
//! protocol integration.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "antigravity",
    display_name: "Antigravity CLI",
    binary_name: "agy",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_history_is_read_from_its_index_not_scanned_files() {
        assert!(DESCRIPTOR.history_shape.is_none());
        assert!(!DESCRIPTOR.has_legacy_hook_artifacts);
    }
}
