#!/bin/bash

# === Colors ===
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
GRAY='\033[90m'
RESET='\033[0m'

OS=""
DISTRO=""
DISTRO_LABEL=""
useMirror=false
NPM_OK=false
GIT_OK=false
registryArgs=""

# ── OS & Distro Detection ─────────────────────────────────────────────────────

detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        DISTRO_LABEL="macOS"
    elif [[ -f /etc/os-release ]]; then
        OS="linux"
        # shellcheck disable=SC1091
        source /etc/os-release
        DISTRO_LABEL="${PRETTY_NAME:-Linux}"
        if   command -v apt-get &>/dev/null; then DISTRO="debian"
        elif command -v dnf     &>/dev/null; then DISTRO="fedora"
        elif command -v yum     &>/dev/null; then DISTRO="rhel"
        elif command -v pacman  &>/dev/null; then DISTRO="arch"
        elif command -v apk     &>/dev/null; then DISTRO="alpine"
        else DISTRO="unknown"
        fi
    else
        OS="unknown"
        DISTRO_LABEL="Unknown OS"
    fi
}

# ── Network Detection ─────────────────────────────────────────────────────────

detect_network() {
    if ! curl -s --connect-timeout 3 https://www.google.com > /dev/null 2>&1; then
        useMirror=true
        registryArgs="--registry=https://registry.npmmirror.com"
        echo -e "    Network       ${YELLOW}China — mirrors enabled${RESET}"
    else
        echo -e "    Network       ${GREEN}Global${RESET}"
    fi
}

# ── Dependency Installers ─────────────────────────────────────────────────────

_install_via_brew() {
    local pkg="$1"
    if ! command -v brew &>/dev/null; then
        echo -e "\n${YELLOW}  Homebrew not found. Installing Homebrew first...${RESET}"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
            echo -e "${RED}  [Error] Homebrew install failed. Visit https://brew.sh to install manually.${RESET}"
            return 1
        }
        # Add brew to PATH for Apple Silicon
        if [[ -f /opt/homebrew/bin/brew ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
    fi
    brew install "$pkg"
}

install_node() {
    echo -e "\n${CYAN}  Installing Node.js...${RESET}"
    case "$OS" in
        macos)
            _install_via_brew node
            ;;
        linux)
            case "$DISTRO" in
                debian) sudo apt-get update -qq && sudo apt-get install -y nodejs npm ;;
                fedora) sudo dnf install -y nodejs ;;
                rhel)   sudo yum install -y nodejs ;;
                arch)   sudo pacman -Sy --noconfirm nodejs npm ;;
                alpine) sudo apk add --no-cache nodejs npm ;;
                *)
                    echo -e "${RED}  [Error] Cannot auto-install on this distro. Visit https://nodejs.org${RESET}"
                    return 1
                    ;;
            esac
            ;;
        *)
            echo -e "${RED}  [Error] Unsupported OS. Visit https://nodejs.org${RESET}"
            return 1
            ;;
    esac
    echo -e "${GREEN}  [OK] Node.js installed.${RESET}"
}

install_git() {
    echo -e "\n${CYAN}  Installing Git...${RESET}"
    case "$OS" in
        macos)
            _install_via_brew git
            ;;
        linux)
            case "$DISTRO" in
                debian) sudo apt-get install -y git ;;
                fedora) sudo dnf install -y git ;;
                rhel)   sudo yum install -y git ;;
                arch)   sudo pacman -Sy --noconfirm git ;;
                alpine) sudo apk add --no-cache git ;;
                *)
                    echo -e "${RED}  [Error] Cannot auto-install on this distro. Visit https://git-scm.com${RESET}"
                    return 1
                    ;;
            esac
            ;;
        *)
            echo -e "${RED}  [Error] Unsupported OS. Visit https://git-scm.com${RESET}"
            return 1
            ;;
    esac
    echo -e "${GREEN}  [OK] Git installed.${RESET}"
}

# ── Dependency Check ──────────────────────────────────────────────────────────

ask_yn() {
    # ask_yn "prompt" → returns 0 for yes, 1 for no
    local reply
    echo -en "${YELLOW}  $1 [Y/n]: ${RESET}"
    read -r reply
    [[ -z "$reply" || "$reply" =~ ^[Yy]$ ]]
}

check_deps() {
    local node_ver="" git_ver=""

    command -v npm &>/dev/null && { NPM_OK=true; node_ver=$(node --version 2>/dev/null); }
    command -v git &>/dev/null && { GIT_OK=true; git_ver=$(git --version 2>/dev/null | awk '{print $3}'); }

    # Print status table
    if $NPM_OK; then
        echo -e "    Node.js       ${GREEN}[OK]${RESET} ${GRAY}${node_ver}${RESET}"
    else
        echo -e "    Node.js       ${RED}[Missing]${RESET}"
    fi
    if $GIT_OK; then
        echo -e "    Git           ${GREEN}[OK]${RESET} ${GRAY}v${git_ver}${RESET}"
    else
        echo -e "    Git           ${RED}[Missing]${RESET}"
    fi
    echo ""

    # Prompt to install missing deps
    if ! $NPM_OK; then
        echo -e "  ${YELLOW}Node.js is required to install agents.${RESET}"
        if ask_yn "Install Node.js now?"; then
            install_node && NPM_OK=true || true
        else
            echo -e "  ${YELLOW}Skipped — agent installs will fail without Node.js.${RESET}"
        fi
        echo ""
    fi

    if ! $GIT_OK; then
        echo -e "  ${YELLOW}Git is required by some agents (e.g. Claude Code).${RESET}"
        if ask_yn "Install Git now?"; then
            install_git && GIT_OK=true || true
        else
            echo -e "  ${YELLOW}Skipped — some agents may not work without Git.${RESET}"
        fi
        echo ""
    fi
}

setup_npm_mirror() {
    $NPM_OK || return
    if $useMirror; then
        npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
    else
        npm config delete registry >/dev/null 2>&1 || true
    fi
}

# ── Helpers ───────────────────────────────────────────────────────────────────

print_success() {
    echo -e "\n----------------------------------------"
    echo -e "${GREEN}  [Success] $1 installed!${RESET}"
    echo -e "${GRAY}  Homepage : $2${RESET}"
    echo -e "${GRAY}  Verify   : $3${RESET}"
    echo -e "----------------------------------------"
    echo -en "\n  Press Enter to return to menu..."
    read -r
}

run_install() {
    # run_install <display-name> <cmd> [args...]
    local name="$1"; shift
    if "$@"; then
        return 0
    else
        echo -e "\n${RED}  [Error] Installation failed. See output above.${RESET}"
        echo -en "  Press Enter to return to menu..."
        read -r
        return 1
    fi
}

run_uninstall() {
    local name="$1"; shift
    if "$@"; then
        echo -e "${GREEN}  [OK] $name uninstalled.${RESET}"
    else
        echo -e "${RED}  [Error] Uninstall failed.${RESET}"
    fi
    echo -en "\n  Press Enter to return to menu..."
    read -r
}

# ── Startup ───────────────────────────────────────────────────────────────────

clear
echo -e "============================\n"
echo -e "      ${CYAN}Agent Installer${RESET}"
echo -e "\n============================\n"

detect_os

echo -e "  Checking your environment...\n"
echo -e "    System        ${CYAN}${DISTRO_LABEL}${RESET}"
detect_network
check_deps
setup_npm_mirror

echo -en "  All set! Press Enter to open the menu..."
read -r

# ── Menu Loop ─────────────────────────────────────────────────────────────────

while true; do
    clear

    echo -e "${CYAN}=== Install ===${RESET}"
    echo "  1.  Claude Code"
    echo "  2.  OpenAI Codex CLI"
    echo "  3.  OpenCode CLI"
    echo "  4.  Hermes (Nous Research)"
    echo -e "\n${YELLOW}=== Uninstall ===${RESET}"
    echo "  5.  Claude Code"
    echo "  6.  OpenAI Codex CLI"
    echo "  7.  OpenCode CLI"
    echo "  8.  Hermes"
    echo -e "\n${GRAY}  q.  Quit${RESET}"
    echo "--------------------------------"

    read -r -p ">>> Select: " choice

    case "$choice" in
        1)
            echo -e "\n${CYAN}  Installing Claude Code...${RESET}\n"
            # shellcheck disable=SC2086
            if run_install "Claude Code" npm install -g @anthropic-ai/claude-code $registryArgs; then
                print_success "Claude Code" "https://claude.ai/code" "claude --version"
            fi
            ;;
        2)
            echo -e "\n${CYAN}  Installing OpenAI Codex CLI...${RESET}\n"
            # shellcheck disable=SC2086
            if run_install "OpenAI Codex" npm install -g @openai/codex@latest $registryArgs; then
                print_success "OpenAI Codex CLI" "https://github.com/openai/codex" "codex --version"
            fi
            ;;
        3)
            echo -e "\n${CYAN}  Installing OpenCode CLI...${RESET}\n"
            # shellcheck disable=SC2086
            if run_install "OpenCode" npm install -g opencode-ai@latest $registryArgs; then
                print_success "OpenCode CLI" "https://opencode.ai" "opencode --version"
            fi
            ;;
        4)
            echo -e "\n${CYAN}  Installing Hermes (Nous Research)...${RESET}\n"
            if bash <(curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh); then
                print_success "Hermes" "https://hermes-agent.nousresearch.com" "hermes --version"
            else
                echo -e "\n${RED}  [Error] Installation failed. See output above.${RESET}"
                echo -en "  Press Enter to return to menu..."
                read -r
            fi
            ;;
        5)
            echo -e "\n${YELLOW}  Uninstalling Claude Code...${RESET}\n"
            run_uninstall "Claude Code" npm uninstall -g @anthropic-ai/claude-code
            ;;
        6)
            echo -e "\n${YELLOW}  Uninstalling OpenAI Codex CLI...${RESET}\n"
            run_uninstall "OpenAI Codex CLI" npm uninstall -g @openai/codex
            ;;
        7)
            echo -e "\n${YELLOW}  Uninstalling OpenCode CLI...${RESET}\n"
            run_uninstall "OpenCode CLI" npm uninstall -g opencode-ai
            ;;
        8)
            echo -e "\n${YELLOW}  Uninstalling Hermes...${RESET}\n"
            if command -v uv &>/dev/null; then
                run_uninstall "Hermes" uv pip uninstall hermes-agent -y
            else
                run_uninstall "Hermes" pip uninstall hermes-agent -y
            fi
            ;;
        q|Q)
            echo -e "\n  Goodbye!\n"
            break
            ;;
        *)
            echo -e "${RED}  Invalid option.${RESET}"
            sleep 1
            ;;
    esac
done
