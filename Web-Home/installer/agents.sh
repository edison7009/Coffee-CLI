# agents.sh — Agents sub-menu. Sourced by menu.sh.
# Lazy-detects prerequisites: only checks npm/Node.js when the user picks
# an npm-based agent. Invokes official install commands.
#
# Depends on: coffee_show_menu / coffee_t (menu.sh).

_agent_have_cmd() { command -v "$1" >/dev/null 2>&1; }

_agent_is_china() {
    curl -s --max-time 3 https://www.google.com >/dev/null 2>&1 && return 1
    return 0
}

_agent_ensure_node() {
    _agent_have_cmd npm && return 0

    printf '\n  \033[33m%s\033[0m\n' "$(coffee_t agents node.required)"
    local ans
    read -r -p "  $(coffee_t agents node.install_prompt): " ans
    if [[ -n "$ans" && ! "$ans" =~ ^[Yy]$ ]]; then
        return 1
    fi

    printf '  \033[36m%s\033[0m\n' "$(coffee_t agents node.downloading)"
    local os ok=0
    os="$(uname -s)"
    if [[ "$os" == "Darwin" ]]; then
        if _agent_have_cmd brew; then
            brew install node && ok=1
        else
            printf '  \033[31mHomebrew not found. Install from https://brew.sh then retry.\033[0m\n'
        fi
    else
        if _agent_have_cmd apt-get; then
            sudo apt-get update && sudo apt-get install -y nodejs npm && ok=1
        elif _agent_have_cmd dnf; then
            sudo dnf install -y nodejs npm && ok=1
        elif _agent_have_cmd pacman; then
            sudo pacman -S --noconfirm nodejs npm && ok=1
        else
            printf '  \033[31mUnsupported package manager. Install Node.js manually.\033[0m\n'
        fi
    fi

    if [[ $ok -eq 1 ]] && _agent_have_cmd npm; then
        if _agent_is_china; then
            npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
        fi
        printf '  \033[32m%s\033[0m\n' "$(coffee_t agents node.install_ok)"
        return 0
    fi
    printf '  \033[31m%s\033[0m\n' "$(coffee_t agents node.npm_not_found)"
    return 1
}

# ── Install / uninstall recipes ──────────────────────────────────────────

_agent_install_claude() {
    # Anthropic official native installer (Bun-compiled standalone).
    curl -fsSL https://claude.ai/install.sh | bash
}
_agent_uninstall_claude() {
    rm -f "$HOME/.local/bin/claude" 2>/dev/null
    rm -rf "$HOME/.local/share/claude" 2>/dev/null
    return 0
}

_agent_install_qwen() {
    bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)" -s --source qwenchat
}
_agent_uninstall_qwen() { npm uninstall -g "@qwen-code/qwen-code"; }

_agent_install_opencode() { npm install -g "opencode-ai@latest"; }
_agent_uninstall_opencode() { npm uninstall -g "opencode-ai"; }

_agent_install_hermes() {
    if _agent_have_cmd uv; then
        uv pip install hermes-agent
    else
        pip install hermes-agent
    fi
}
_agent_uninstall_hermes() {
    if _agent_have_cmd uv; then
        uv pip uninstall hermes-agent -y
    else
        pip uninstall hermes-agent -y
    fi
}

# Catalog rows: i18n_key|detect_cmd|homepage|verify_cmd|npm(0/1)|install_fn|uninstall_fn
_agent_catalog=(
    "label.claude|claude|https://claude.ai/code|claude --version|0|_agent_install_claude|_agent_uninstall_claude"
    "label.qwen|qwen|https://qwen.ai/qwencode|qwen --version|1|_agent_install_qwen|_agent_uninstall_qwen"
    "label.opencode|opencode|https://opencode.ai|opencode --version|1|_agent_install_opencode|_agent_uninstall_opencode"
    "label.hermes|hermes|https://hermes-agent.nousresearch.com|hermes --version|0|_agent_install_hermes|_agent_uninstall_hermes"
)

_agent_invoke_action() {
    local name="$1" homepage="$2" verify="$3" detect="$4" npm="$5"
    local install_fn="$6" uninstall_fn="$7"

    clear
    printf '\n  \033[36m%s\033[0m\n' "$name"
    local dashes
    printf -v dashes '%*s' "${#name}" ''
    printf '  \033[90m%s\033[0m\n' "${dashes// /-}"

    local action=""
    if _agent_have_cmd "$detect"; then
        printf '  \033[32m%s\033[0m\n\n' "$(coffee_t agents status.installed)"
        coffee_show_menu "$(coffee_t agents action.title name "$name")" "sub" \
            "$(coffee_t agents action.reinstall)" "act:install" \
            "$(coffee_t agents action.uninstall)" "act:uninstall" \
            "$(coffee_t agents action.back)"      "action:__back__"
        case "$COFFEE_MENU_CHOICE" in
            action:__back__) return ;;
            act:*) action="${COFFEE_MENU_CHOICE#act:}" ;;
        esac
    else
        printf '  \033[90m%s\033[0m\n\n' "$(coffee_t agents status.not_installed)"
        local ans
        read -r -p "  $(coffee_t agents prompt.install_confirm name "$name"): " ans
        if [[ -n "$ans" && ! "$ans" =~ ^[Yy]$ ]]; then
            return
        fi
        action="install"
    fi

    local _
    if [[ "$action" == "install" ]]; then
        if [[ "$npm" == "1" ]] && ! _agent_ensure_node; then
            printf '\n  %s\n' "$(coffee_t agents msg.skipped_needs_node)"
            read -r -p "  $(coffee_t menu common.press_enter_continue) " _
            return
        fi
        printf '\n  \033[36m%s\033[0m\n' "$(coffee_t agents msg.installing name "$name")"
        if "$install_fn"; then
            printf '\n  \033[32m%s\033[0m\n' "$(coffee_t agents msg.install_ok name "$name")"
            printf '  \033[90m%s\033[0m\n' "$(coffee_t agents msg.homepage url "$homepage")"
            printf '  \033[90m%s\033[0m\n' "$(coffee_t agents msg.verify cmd "$verify")"
        else
            printf '  \033[31m%s\033[0m\n' "$(coffee_t agents msg.install_err err "install failed")"
        fi
    elif [[ "$action" == "uninstall" ]]; then
        printf '\n  \033[33m%s\033[0m\n' "$(coffee_t agents msg.uninstalling name "$name")"
        if "$uninstall_fn"; then
            printf '  \033[32m%s\033[0m\n' "$(coffee_t agents msg.uninstall_ok name "$name")"
        else
            printf '  \033[31m%s\033[0m\n' "$(coffee_t agents msg.uninstall_err err "uninstall failed")"
        fi
    fi
    printf '\n'
    read -r -p "  $(coffee_t menu common.press_enter_continue) " _
}

# ── Menu loop ────────────────────────────────────────────────────────────

while true; do
    _items=()
    for entry in "${_agent_catalog[@]}"; do
        IFS='|' read -r _key _detect _homepage _verify _npm _install_fn _uninstall_fn <<< "$entry"
        _name=$(coffee_t agents "$_key")
        _suffix=""
        _agent_have_cmd "$_detect" && _suffix="$(coffee_t agents status.installed_suffix)"
        _items+=("$_name$_suffix" "key:$_key")
    done
    _items+=("$(coffee_t agents action.back)" "action:__back__")

    coffee_show_menu "$(coffee_t agents title)" "sub" "${_items[@]}"
    case "$COFFEE_MENU_CHOICE" in
        action:__back__) return ;;
        key:*)
            _picked="${COFFEE_MENU_CHOICE#key:}"
            for entry in "${_agent_catalog[@]}"; do
                IFS='|' read -r _key _detect _homepage _verify _npm _install_fn _uninstall_fn <<< "$entry"
                if [[ "$_key" == "$_picked" ]]; then
                    _name=$(coffee_t agents "$_key")
                    _agent_invoke_action "$_name" "$_homepage" "$_verify" "$_detect" "$_npm" "$_install_fn" "$_uninstall_fn"
                    break
                fi
            done
            ;;
    esac
done
