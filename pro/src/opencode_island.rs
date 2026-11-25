//! Process-local OpenCode v2 TUI integration. No changes to OpenCode's config files.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;

const PLUGIN: &str = include_str!("integrations/opencode-island/tui.mjs");
const MANIFEST: &str =
    r#"{"name":"coffee-cli-island","type":"module","exports":{"./tui":"./tui.mjs"}}"#;

fn read_jsonc(text: &str) -> Result<Value> {
    let value: Value = jsonc_parser::parse_to_serde_value(
        text.trim_start_matches('\u{feff}'),
        &jsonc_parser::ParseOptions {
            allow_trailing_commas: true,
            ..Default::default()
        },
    )?;
    if !value.is_object() {
        bail!("OpenCode CLI configuration is not an object");
    }
    Ok(value)
}

fn overlay(config: &Value, inherited: Option<&str>, plugin: &str) -> Result<String> {
    let mut content = inherited
        .map(read_jsonc)
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let plugins = content.get("plugins").or_else(|| config.get("plugins"));
    let mut plugins = match plugins {
        None => vec![],
        Some(Value::Array(plugins)) => plugins.clone(),
        _ => bail!("OpenCode CLI plugins is not an array"),
    };
    plugins.push(Value::String(plugin.to_string()));
    content["plugins"] = Value::Array(plugins);
    Ok(serde_json::to_string(&content)?)
}

pub fn environment(extra_env: &[(String, String)]) -> Result<String> {
    let home = dirs::home_dir().context("home directory unavailable")?;
    let config_root = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let config_dir = config_root.join("opencode");
    // v2 migrates tui.json to cli.json on first launch. Preserve its plugins too.
    let config_path = if config_dir.join("cli.json").exists() {
        config_dir.join("cli.json")
    } else {
        config_dir.join("tui.json")
    };
    let config = match std::fs::read_to_string(config_path) {
        Ok(text) => read_jsonc(&text)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    let inherited = extra_env
        .iter()
        .rev()
        .find(|(key, _)| key == "OPENCODE_CLI_CONFIG_CONTENT")
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("OPENCODE_CLI_CONFIG_CONTENT").ok());
    let directory = home
        .join(".coffee-cli")
        .join("integrations")
        .join("opencode-island");
    // Use a file URL so spaces, drive letters and non-ASCII home paths survive.
    let url = reqwest::Url::from_directory_path(&directory)
        .map_err(|_| anyhow::anyhow!("invalid OpenCode integration path"))?;
    let content = overlay(&config, inherited.as_deref(), url.as_str())?;
    std::fs::create_dir_all(&directory)?;
    write_changed(&directory.join("package.json"), MANIFEST)?;
    write_changed(&directory.join("tui.mjs"), PLUGIN)?;
    Ok(content)
}

fn write_changed(path: &Path, text: &str) -> Result<()> {
    if std::fs::read(path).ok().as_deref() != Some(text.as_bytes()) {
        // Several tabs can launch together; readers must never see half a plugin.
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, text)?;
        if let Err(error) = std::fs::rename(&temporary, path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_plugins_and_process_overrides_without_mutating_config() {
        let config = read_jsonc(r#"{ // user plugins
            "plugins": ["user-plugin", {"package":"./local","options":{"enabled":true}}, "-disabled"],
        }"#).unwrap();
        let content: Value = serde_json::from_str(
            &overlay(&config, Some(r#"{"mouse":false}"#), "file:///test/").unwrap(),
        )
        .unwrap();
        assert_eq!(content["mouse"], false);
        assert_eq!(content["plugins"][0], "user-plugin");
        assert_eq!(content["plugins"][1], config["plugins"][1]);
        assert_eq!(content["plugins"][2], "-disabled");
        assert_eq!(content["plugins"][3], "file:///test/");
        assert_eq!(config["plugins"].as_array().unwrap().len(), 3);
        let content: Value = serde_json::from_str(
            &overlay(
                &config,
                Some(r#"{"plugins":["env-plugin"]}"#),
                "file:///test/",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(content["plugins"], json!(["env-plugin", "file:///test/"]));
    }

    #[test]
    fn malformed_user_configuration_is_not_replaced() {
        assert!(read_jsonc("{ broken").is_err());
        assert!(overlay(&json!({}), Some("[]"), "file:///test/").is_err());
        assert!(overlay(&json!({"plugins":false}), None, "file:///test/").is_err());
    }

    #[test]
    fn concurrent_launches_publish_complete_plugin_files() {
        let directory =
            std::env::temp_dir().join(format!("coffee-opencode-island-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("tui.mjs");
        std::fs::write(&path, "old").unwrap();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| write_changed(&path, PLUGIN).unwrap());
            }
        });
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PLUGIN);
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
