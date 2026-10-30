//! Resolves the endpoint a CLI will call from that CLI's own configuration files.
//! Read-only: nothing here writes or rewrites a tool's settings.
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    /// The vendor's own sign-in; quota comes from the CLI protocol.
    Official,
    Endpoint { base_url: String, api_key: String },
    Unknown,
}

pub struct Context<'a> {
    pub home: PathBuf,
    pub cwd: Option<PathBuf>,
    pub var: &'a dyn Fn(&str) -> Option<String>,
    pub claude_managed: Option<PathBuf>,
}

impl Context<'_> {
    fn var(&self, key: &str) -> Option<String> {
        (self.var)(key).map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    }
    fn dir(&self, key: &str, fallback: &str) -> PathBuf {
        self.var(key).map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or_else(|| self.home.join(fallback))
    }
}

pub fn resolve(tool: &str, cx: &Context) -> Route {
    match tool {
        "claude" => claude(cx),
        "codex" => codex(cx),
        "opencode" | "kilo" | "mimocode" => opencode_family(tool, cx),
        "cline" => cline(cx),
        "pi" => pi(cx),
        "omp" => omp(cx),
        _ => Route::Unknown,
    }
}

/// Providers the tools ship built in, limited to those whose usage we can read.
fn builtin(provider: &str) -> Option<(&'static str, &'static str)> {
    Some(match provider {
        "deepseek" => ("https://api.deepseek.com", "DEEPSEEK_API_KEY"),
        "openrouter" => ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
        "kimi-for-coding" => ("https://api.kimi.com/coding/v1", "KIMI_API_KEY"),
        "zhipuai" => ("https://open.bigmodel.cn/api/paas/v4", "ZHIPU_API_KEY"),
        "zhipuai-coding-plan" => ("https://open.bigmodel.cn/api/coding/paas/v4", "ZHIPU_API_KEY"),
        "zai" => ("https://api.z.ai/api/paas/v4", "ZHIPU_API_KEY"),
        "zai-coding-plan" => ("https://api.z.ai/api/coding/paas/v4", "ZHIPU_API_KEY"),
        "minimax" => ("https://api.minimax.io/v1", "MINIMAX_API_KEY"),
        "minimax-cn" => ("https://api.minimaxi.com/v1", "MINIMAX_API_KEY"),
        "siliconflow" => ("https://api.siliconflow.com/v1", "SILICONFLOW_API_KEY"),
        "siliconflow-cn" => ("https://api.siliconflow.cn/v1", "SILICONFLOW_API_KEY"),
        "stepfun" => ("https://api.stepfun.com/v1", "STEPFUN_API_KEY"),
        "novita" | "novita-ai" => ("https://api.novita.ai/v3/openai", "NOVITA_API_KEY"),
        "zenmux" => ("https://zenmux.ai/api/v1", "ZENMUX_API_KEY"),
        "opencode-go" => ("https://opencode.ai/zen/go/v1", "OPENCODE_API_KEY"),
        _ => return None,
    })
}

fn endpoint(base_url: Option<String>, api_key: Option<String>) -> Route {
    let (Some(base_url), Some(api_key)) = (base_url.filter(|s| !s.trim().is_empty()), api_key.filter(|s| !s.trim().is_empty())) else { return Route::Unknown };
    // A local proxy (cc-switch, a gateway) hides the provider behind it.
    let local = url::Url::parse(&base_url).ok().and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_none_or(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1" | "0.0.0.0"));
    if local { Route::Unknown } else { Route::Endpoint { base_url: base_url.trim().to_string(), api_key: api_key.trim().to_string() } }
}

fn read_text(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    let value: Value = jsonc_parser::parse_to_serde_value(&read_text(path)?, &jsonc_parser::ParseOptions { allow_trailing_commas: true, ..Default::default() }).ok()?;
    value.is_object().then_some(value)
}

fn str_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn merge(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                match target.get_mut(&key) { Some(existing) => merge(existing, value), None => { target.insert(key, value); } }
            }
        }
        (target, source) => *target = source,
    }
}

fn host(base_url: &str) -> Option<String> {
    url::Url::parse(base_url).ok()?.host_str().map(str::to_ascii_lowercase)
}

// ── Claude Code ──────────────────────────────────────────────────────────

/// Settings `env` blocks override the inherited environment; later files win:
/// user < project < local project < managed policy.
fn claude(cx: &Context) -> Route {
    let keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
    let mut env: Map<String, Value> = keys.iter().filter_map(|key| cx.var(key).map(|value| (key.to_string(), Value::String(value)))).collect();
    let user = cx.var("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| cx.home.join(".claude"));
    let mut files = vec![user.join("settings.json")];
    if let Some(cwd) = &cx.cwd { files.extend([cwd.join(".claude/settings.json"), cwd.join(".claude/settings.local.json")]); }
    files.extend(cx.claude_managed.clone());
    for file in files {
        if let Some(Value::Object(block)) = read_json(&file).and_then(|settings| settings.get("env").cloned()) { env.extend(block); }
    }
    let get = |key: &str| env.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let truthy = |key: &str| get(key).is_some_and(|value| !matches!(value.as_str(), "0" | "false"));
    if truthy("CLAUDE_CODE_USE_BEDROCK") || truthy("CLAUDE_CODE_USE_VERTEX") || truthy("CLAUDE_CODE_USE_FOUNDRY") { return Route::Unknown; }
    match get("ANTHROPIC_BASE_URL") {
        None => Route::Official,
        Some(base) if host(&base).as_deref() == Some("api.anthropic.com") => Route::Official,
        base => endpoint(base, get("ANTHROPIC_AUTH_TOKEN").or_else(|| get("ANTHROPIC_API_KEY"))),
    }
}

// ── Codex CLI ────────────────────────────────────────────────────────────

fn codex(cx: &Context) -> Route {
    let dir = cx.dir("CODEX_HOME", ".codex");
    let config: toml::Table = read_text(&dir.join("config.toml")).and_then(|text| text.parse().ok()).unwrap_or_default();
    let profile = config.get("profile").and_then(|v| v.as_str()).and_then(|name| config.get("profiles")?.get(name)?.as_table());
    let provider = profile.and_then(|p| p.get("model_provider")).or_else(|| config.get("model_provider"))
        .and_then(|v| v.as_str()).unwrap_or("openai").to_string();
    let auth_key = || read_json(&dir.join("auth.json")).and_then(|auth| str_at(&auth, "/OPENAI_API_KEY"));
    if provider.eq_ignore_ascii_case("openai") {
        // OPENAI_BASE_URL reroutes the built-in provider to a compatible endpoint.
        return match cx.var("OPENAI_BASE_URL") { Some(base) => endpoint(Some(base), cx.var("OPENAI_API_KEY").or_else(auth_key)), None => Route::Official };
    }
    let Some(entry) = config.get("model_providers").and_then(|p| p.get(&provider)) else { return Route::Unknown };
    let field = |key: &str| entry.get(key).and_then(|v| v.as_str()).map(String::from);
    let key = field("env_key").and_then(|name| cx.var(&name)).or_else(|| field("experimental_bearer_token")).or_else(auth_key);
    endpoint(field("base_url"), key)
}

// ── OpenCode and its forks (Kilo CLI, MiMo CLI) ──────────────────────────

fn opencode_family(tool: &str, cx: &Context) -> Route {
    let name = tool;
    let config_root = cx.dir("XDG_CONFIG_HOME", ".config");
    let global = if tool == "opencode" { cx.var("OPENCODE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| config_root.join(name)) } else { config_root.join(name) };
    let mut files = vec![global.join("config.json"), global.join(format!("{name}.json")), global.join(format!("{name}.jsonc"))];
    if tool == "opencode" { files.extend(cx.var("OPENCODE_CONFIG").map(PathBuf::from)); }
    // Project files apply from the repository root inward.
    let mut project = Vec::new();
    let mut dir = cx.cwd.clone();
    while let Some(current) = dir {
        project.push(current.clone());
        if current.join(".git").exists() || project.len() >= 32 { break; }
        dir = current.parent().map(Path::to_path_buf);
    }
    for dir in project.iter().rev() {
        for base in [dir.clone(), dir.join(format!(".{name}"))] {
            files.extend([base.join(format!("{name}.json")), base.join(format!("{name}.jsonc"))]);
        }
    }
    let mut config = Value::Object(Map::new());
    let mut sources = Vec::new();
    for file in files {
        if let Some(value) = read_json(&file) { sources.push((file.parent().map(Path::to_path_buf).unwrap_or_default(), value.clone())); merge(&mut config, value); }
    }
    let selected = str_at(&config, "/model").or_else(|| {
        let state = read_json(&cx.dir("XDG_STATE_HOME", ".local/state").join(name).join("model.json"))?;
        let recent = state.pointer("/recent/0")?;
        Some(format!("{}/{}", str_at(recent, "/providerID")?, str_at(recent, "/modelID")?))
    });
    let Some((provider, _)) = selected.as_deref().and_then(|s| s.split_once('/')) else { return Route::Unknown };
    let options = config.pointer(&format!("/provider/{}/options", pointer_escape(provider))).cloned().unwrap_or(Value::Null);
    // {file:...} paths are relative to the file that declared them; the last one wins.
    let declared = sources.iter().rev().find(|(_, value)| value.pointer(&format!("/provider/{}/options/apiKey", pointer_escape(provider))).is_some()).map(|(dir, _)| dir.clone()).unwrap_or_else(|| global.clone());
    let substitute = |text: String| substitute_opencode(&text, cx, &declared);
    let builtin = builtin(provider);
    let base = str_at(&options, "/baseURL").and_then(substitute).or_else(|| builtin.map(|(base, _)| base.to_string()));
    let key = str_at(&options, "/apiKey").and_then(substitute)
        .or_else(|| {
            let auth = read_json(&cx.dir("XDG_DATA_HOME", ".local/share").join(name).join("auth.json"))?;
            (auth.pointer(&format!("/{}/type", pointer_escape(provider))).and_then(Value::as_str) == Some("api")).then(|| str_at(&auth, &format!("/{}/key", pointer_escape(provider)))).flatten()
        })
        .or_else(|| builtin.and_then(|(_, var)| cx.var(var)));
    endpoint(base, key)
}

fn pointer_escape(key: &str) -> String { key.replace('~', "~0").replace('/', "~1") }

/// OpenCode config values may embed `{env:NAME}` and `{file:path}`.
fn substitute_opencode(text: &str, cx: &Context, dir: &Path) -> Option<String> {
    let pattern = regex::Regex::new(r"\{(env|file):([^}]+)\}").unwrap();
    let mut failed = false;
    let value = pattern.replace_all(text, |caps: &regex::Captures| {
        let target = caps[2].trim();
        let value = if &caps[1] == "env" { cx.var(target) } else {
            let path = target.strip_prefix("~/").map(|rest| cx.home.join(rest)).unwrap_or_else(|| { let p = PathBuf::from(target); if p.is_absolute() { p } else { dir.join(p) } });
            read_text(&path).map(|s| s.trim().to_string())
        };
        value.unwrap_or_else(|| { failed = true; String::new() })
    }).into_owned();
    (!failed && !value.trim().is_empty()).then_some(value)
}

// ── Cline CLI ────────────────────────────────────────────────────────────

fn cline(cx: &Context) -> Route {
    let path = cx.var("CLINE_PROVIDER_SETTINGS_PATH").map(PathBuf::from).unwrap_or_else(|| {
        cx.var("CLINE_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| cx.var("CLINE_DIR").map(PathBuf::from).unwrap_or_else(|| cx.home.join(".cline")).join("data")).join("settings/providers.json")
    });
    let Some(state) = read_json(&path) else { return Route::Unknown };
    let Some(provider) = str_at(&state, "/lastUsedProvider") else { return Route::Unknown };
    let settings = state.pointer(&format!("/providers/{}/settings", pointer_escape(&provider))).cloned().unwrap_or(Value::Null);
    let builtin = builtin(&provider);
    endpoint(str_at(&settings, "/baseUrl").or_else(|| builtin.map(|(base, _)| base.to_string())),
        str_at(&settings, "/apiKey").or_else(|| builtin.and_then(|(_, var)| cx.var(var))))
}

// ── Pi and Oh My Pi ──────────────────────────────────────────────────────

/// Pi's apiKey is an environment variable name or a literal; `!command` keys are
/// never executed here.
fn pi_key(value: Option<String>, cx: &Context) -> Option<String> {
    let value = value?;
    if value.starts_with('!') { return None; }
    Some(cx.var(&value).unwrap_or(value))
}

fn pi_route(provider: &str, entry: Option<(Option<String>, Option<String>)>, auth: Option<Value>, cx: &Context) -> Route {
    let (base, key) = entry.unwrap_or((None, None));
    let builtin = builtin(provider);
    let key = pi_key(key, cx)
        .or_else(|| auth.and_then(|auth| str_at(&auth, &format!("/{}/key", pointer_escape(provider)))))
        .or_else(|| builtin.and_then(|(_, var)| cx.var(var)));
    endpoint(base.or_else(|| builtin.map(|(base, _)| base.to_string())), key)
}

fn pi(cx: &Context) -> Route {
    let dir = cx.dir("PI_CODING_AGENT_DIR", ".pi/agent");
    let mut settings = read_json(&dir.join("settings.json")).unwrap_or(Value::Object(Map::new()));
    if let Some(project) = cx.cwd.as_ref().and_then(|cwd| read_json(&cwd.join(".pi/settings.json"))) { merge(&mut settings, project); }
    let Some(provider) = str_at(&settings, "/defaultProvider") else { return Route::Unknown };
    let entry = read_json(&dir.join("models.json")).and_then(|models| {
        let entry = models.pointer(&format!("/providers/{}", pointer_escape(&provider)))?.clone();
        Some((str_at(&entry, "/baseUrl"), str_at(&entry, "/apiKey")))
    });
    pi_route(&provider, entry, read_json(&dir.join("auth.json")), cx)
}

fn read_yaml(dir: &Path, stem: &str) -> Option<Value> {
    let path = [format!("{stem}.yml"), format!("{stem}.yaml")].into_iter().map(|name| dir.join(name)).find(|path| path.exists())?;
    serde_yaml_ng::from_str::<Value>(&read_text(&path)?).ok().filter(Value::is_object)
}

fn omp(cx: &Context) -> Route {
    let dir = cx.dir("PI_CODING_AGENT_DIR", ".omp/agent");
    let Some(selector) = read_yaml(&dir, "config").and_then(|config| str_at(&config, "/modelRoles/default")) else { return Route::Unknown };
    let Some((provider, _)) = selector.split_once('/') else { return Route::Unknown };
    let entry = read_yaml(&dir, "models").and_then(|models| {
        let entry = models.pointer(&format!("/providers/{}", pointer_escape(provider)))?.clone();
        Some((str_at(&entry, "/baseUrl"), str_at(&entry, "/apiKey")))
    });
    pi_route(provider, entry, None, cx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Fixture { root: PathBuf }
    impl Fixture {
        fn new() -> Self { Self { root: std::env::temp_dir().join(format!("coffee-quota-{}", uuid::Uuid::new_v4())) } }
        fn write(&self, path: &str, text: &str) -> &Self {
            let path = self.root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
            self
        }
        fn resolve(&self, tool: &str, vars: &[(&str, &str)]) -> Route {
            let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.replace("<root>", &self.root.to_string_lossy()))).collect();
            let lookup = move |key: &str| vars.get(key).cloned();
            resolve(tool, &Context { home: self.root.join("home"), cwd: Some(self.root.join("repo/app")), var: &lookup, claude_managed: Some(self.root.join("managed.json")) })
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

    fn at(base: &str, key: &str) -> Route { Route::Endpoint { base_url: base.into(), api_key: key.into() } }

    #[test]
    fn claude_follows_settings_precedence_and_official_sign_in() {
        let f = Fixture::new();
        f.write("home/.claude/settings.json", r#"{"model":"opus[1m]","theme":"auto"}"#);
        assert_eq!(f.resolve("claude", &[]), Route::Official);
        assert_eq!(f.resolve("claude", &[("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic"), ("ANTHROPIC_AUTH_TOKEN", "shell")]), at("https://api.deepseek.com/anthropic", "shell"));
        f.write("home/.claude/settings.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://user.example","ANTHROPIC_AUTH_TOKEN":"user"}}"#);
        assert_eq!(f.resolve("claude", &[("ANTHROPIC_BASE_URL", "https://shell.example")]), at("https://user.example", "user"));
        f.write("repo/app/.claude/settings.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://project.example"}}"#);
        f.write("repo/app/.claude/settings.local.json", r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"local"}}"#);
        assert_eq!(f.resolve("claude", &[]), at("https://project.example", "local"));
        f.write("managed.json", r#"{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:15721"}}"#);
        assert_eq!(f.resolve("claude", &[]), Route::Unknown);
        f.write("managed.json", r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}"#);
        assert_eq!(f.resolve("claude", &[]), Route::Official);
        assert_eq!(f.resolve("claude", &[("CLAUDE_CODE_USE_BEDROCK", "1")]), Route::Unknown);
        assert_eq!(f.resolve("claude", &[("CLAUDE_CONFIG_DIR", "<root>/elsewhere")]), Route::Official);
    }

    #[test]
    fn codex_reads_profiles_providers_and_keys() {
        let f = Fixture::new();
        f.write("home/.codex/config.toml", "model_provider = \"OpenAI\"\n[desktop]\nfollowUpQueueMode = \"steer\"\n");
        f.write("home/.codex/auth.json", r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{}}"#);
        assert_eq!(f.resolve("codex", &[]), Route::Official);
        f.write("home/.codex/config.toml", "model = \"deepseek-chat\"\nmodel_provider = \"ds\"\n[model_providers.ds]\nbase_url = \"https://api.deepseek.com/v1\"\nenv_key = \"DS_KEY\"\n");
        assert_eq!(f.resolve("codex", &[("DS_KEY", "env")]), at("https://api.deepseek.com/v1", "env"));
        f.write("home/.codex/auth.json", r#"{"OPENAI_API_KEY":"stored"}"#);
        assert_eq!(f.resolve("codex", &[]), at("https://api.deepseek.com/v1", "stored"));
        f.write("home/.codex/config.toml", "profile = \"work\"\nmodel_provider = \"ds\"\n[profiles.work]\nmodel_provider = \"relay\"\n[model_providers.ds]\nbase_url = \"https://api.deepseek.com/v1\"\n[model_providers.relay]\nbase_url = \"https://relay.example/v1\"\nexperimental_bearer_token = \"bearer\"\n");
        assert_eq!(f.resolve("codex", &[]), at("https://relay.example/v1", "bearer"));
        f.write("custom/config.toml", "model_provider = \"ollama\"\n");
        assert_eq!(f.resolve("codex", &[("CODEX_HOME", "<root>/custom")]), Route::Unknown);
    }

    #[test]
    fn opencode_family_merges_configs_and_resolves_substitutions() {
        let f = Fixture::new();
        // The shape EchoBird writes, with the Anthropic adapter's /v1 suffix.
        f.write("home/.config/opencode/opencode.jsonc", "{\n// selected\n\"model\": \"echobird/deepseek-flash\",\n\"provider\": {\"echobird\": {\"npm\": \"@ai-sdk/anthropic\", \"options\": {\"apiKey\": \"sk-a\", \"baseURL\": \"https://api.deepseek.com/anthropic/v1\"},},},\n}");
        assert_eq!(f.resolve("opencode", &[]), at("https://api.deepseek.com/anthropic/v1", "sk-a"));
        f.write("repo/.git/HEAD", "").write("repo/opencode.json", r#"{"model":"deepseek/deepseek-chat","provider":{"deepseek":{"options":{"apiKey":"{env:DEEPSEEK_KEY}"}}}}"#);
        assert_eq!(f.resolve("opencode", &[("DEEPSEEK_KEY", "sk-env")]), at("https://api.deepseek.com", "sk-env"));
        assert_eq!(f.resolve("opencode", &[]), Route::Unknown);
        f.write("repo/opencode.json", r#"{"model":"deepseek/deepseek-chat","provider":{"deepseek":{"options":{"apiKey":"{file:keys/ds.txt}"}}}}"#).write("repo/keys/ds.txt", "sk-file\n");
        assert_eq!(f.resolve("opencode", &[]), at("https://api.deepseek.com", "sk-file"));
        // `opencode auth login` keys live in the data directory.
        f.write("home/.config/kilo/kilo.json", r#"{"model":"openrouter/anthropic/claude-sonnet"}"#);
        f.write("home/.local/share/kilo/auth.json", r#"{"kilo":{"type":"oauth","access":"x"},"openrouter":{"type":"api","key":"sk-or"}}"#);
        assert_eq!(f.resolve("kilo", &[]), at("https://openrouter.ai/api/v1", "sk-or"));
        // MiMo with a provider but no selected model stays hidden.
        f.write("home/.config/mimocode/mimocode.jsonc", r#"{"provider":{"echobird-desktop":{"options":{"apiKey":"sk","baseURL":"https://api.deepseek.com"}}}}"#);
        assert_eq!(f.resolve("mimocode", &[]), Route::Unknown);
        f.write("home/.local/state/mimocode/model.json", r#"{"recent":[{"providerID":"echobird-desktop","modelID":"deepseek-flash"}]}"#);
        assert_eq!(f.resolve("mimocode", &[]), at("https://api.deepseek.com", "sk"));
    }

    #[test]
    fn cline_pi_and_omp_read_their_selected_provider() {
        let f = Fixture::new();
        f.write("home/.cline/data/settings/providers.json", r#"{"version":1,"lastUsedProvider":"openai-compatible","providers":{"cline":{"settings":{"provider":"cline"}},"openai-compatible":{"settings":{"apiKey":"sk-c","baseUrl":"https://api.deepseek.com","model":"gpt-4o"}}}}"#);
        assert_eq!(f.resolve("cline", &[]), at("https://api.deepseek.com", "sk-c"));
        f.write("home/.pi/agent/settings.json", r#"{"defaultProvider":"relay","defaultModel":"m"}"#);
        f.write("home/.pi/agent/models.json", r#"{"providers":{"relay":{"baseUrl":"https://relay.example/v1","apiKey":"RELAY_KEY"},"cmd":{"baseUrl":"https://relay.example/v1","apiKey":"!pass show key"}}}"#);
        assert_eq!(f.resolve("pi", &[("RELAY_KEY", "sk-env")]), at("https://relay.example/v1", "sk-env"));
        assert_eq!(f.resolve("pi", &[]), at("https://relay.example/v1", "RELAY_KEY"));
        f.write("repo/app/.pi/settings.json", r#"{"defaultProvider":"cmd"}"#);
        assert_eq!(f.resolve("pi", &[]), Route::Unknown);
        f.write("repo/app/.pi/settings.json", r#"{"defaultProvider":"deepseek"}"#).write("home/.pi/agent/auth.json", r#"{"deepseek":{"type":"api_key","key":"sk-auth"}}"#);
        assert_eq!(f.resolve("pi", &[]), at("https://api.deepseek.com", "sk-auth"));
        f.write("home/.omp/agent/config.yml", "modelRoles:\n  default: zhipu/glm-5\n");
        f.write("home/.omp/agent/models.yml", "providers:\n  zhipu:\n    baseUrl: https://open.bigmodel.cn/api/anthropic\n    api: anthropic-messages\n    apiKey: sk-z\n");
        assert_eq!(f.resolve("omp", &[]), at("https://open.bigmodel.cn/api/anthropic", "sk-z"));
    }
}
