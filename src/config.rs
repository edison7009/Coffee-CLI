// Coffee CLI — Default configuration constants

/// Maximum directory depth to scan
pub const MAX_DEPTH: usize = 8;

/// Maximum number of files to scan
pub const MAX_FILES: usize = 5000;

/// Maximum file size to read (512 KB)
pub const MAX_FILE_SIZE: u64 = 512 * 1024;

/// Token count at which to warn the user (80K tokens ≈ ~320KB of source)
pub const TOKEN_WARNING_THRESHOLD: usize = 80_000;
