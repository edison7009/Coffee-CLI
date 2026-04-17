#!/bin/bash
# Coffee CLI Agent Installer (Unix).
# Usage: curl -fsSL https://coffeecli.com/agent-tools-installer.sh | bash

set -u

# === Colors ===
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
GRAY='\033[90m'
RESET='\033[0m'

OS=""
DISTRO_LABEL=""
useMirror=false
NPM_OK=false
registryArgs=()

# ── OS detection ──────────────────────────────────────────────────────────────
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        DISTRO_LABEL="macOS"
    elif [[ -f /etc/os-release ]]; then
        OS="linux"
        # shellcheck disable=SC1091
        source /etc/os-release
        DISTRO_LABEL="${PRETTY_NAME:-Linux}"
    else
        OS="linux"
        DISTRO_LABEL="Unix"
    fi
}

# ── Network: detect China for npm registry mirror (used only by npm-based agents) ──
detect_network() {
    if curl -s --max-time 3 https://www.google.com >/dev/null 2>&1; then
        useMirror=false
    else
        useMirror=true
    fi
}

# ── Prerequisite check for npm-based agents ──────────────────────────────────
ensure_npm() {
    if command -v npm &>/dev/null; then
        NPM_OK=true
        if $useMirror; then
            npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true
            registryArgs=(--registry https://registry.npmmirror.com)
        fi
        return 0
    fi

    echo -e "\n${YELLOW}  npm not found. Node.js is required for this agent.${RESET}"
    read -r -p "  Install Node.js now? [Y/n]: " ans
    if [[ -n "$ans" && ! "$ans" =~ ^[Yy]$ ]]; then
        return 1
    fi

    if [[ "$OS" == "macos" ]]; then
        if ! command -v brew &>/dev/null; then
            echo -e "${RED}  Homebrew not found. Install manually from https://brew.sh then retry.${RESET}"
            return 1
        fi
        brew install node
    else
        if command -v apt-get &>/dev/null; then
            sudo apt-get update && sudo apt-get install -y nodejs npm
        elif command -v dnf &>/dev/null; then
            sudo dnf install -y nodejs npm
        elif command -v pacman &>/dev/null; then
            sudo pacman -S --noconfirm nodejs npm
        else
            echo -e "${RED}  Unsupported package manager. Install Node.js manually.${RESET}"
            return 1
        fi
    fi

    if command -v npm &>/dev/null; then
        NPM_OK=true
        return 0
    fi
    return 1
}

# ── Helpers ──────────────────────────────────────────────────────────────────
run_install() {
    local name="$1"; shift
    echo -e "${GRAY}  Running: $*${RESET}"
    if "$@"; then
        echo -e "${GREEN}  [OK] $name installed.${RESET}"
        return 0
    fi
    echo -e "${RED}  [Error] $name install failed.${RESET}"
    return 1
}

run_uninstall() {
    local name="$1"; shift
    if "$@"; then
        echo -e "${GREEN}  [OK] $name uninstalled.${RESET}"
    else
        echo -e "${RED}  [Error] $name uninstall failed.${RESET}"
    fi
    echo -en "  Press Enter to continue..."
    read -r
}

print_success() {
    echo -e "\n----------------------------------------"
    echo -e "${GREEN}  [OK] $1 installed!${RESET}"
    echo -e "${GRAY}  Homepage : $2${RESET}"
    echo -e "${GRAY}  Verify   : $3${RESET}"
    echo -e "----------------------------------------"
    echo -en "  Press Enter to continue..."
    read -r
}

# ── Startup ───────────────────────────────────────────────────────────────────
clear
echo -e "============================"
echo -e "     ${CYAN}Agent Installer${RESET}"
echo -e "============================\n"

detect_os
detect_network

echo "    System        $DISTRO_LABEL"
if $useMirror; then
    echo -e "    Network       ${YELLOW}China - mirrors enabled${RESET}"
else
    echo -e "    Network       ${GREEN}Global${RESET}"
fi
echo ""
echo -en "  Press Enter to open menu..."
read -r

# ── Menu loop ─────────────────────────────────────────────────────────────────
while true; do
    clear
    echo -e "${CYAN}=== Agent Installer ===${RESET}"
    echo ""
    echo -e "${CYAN}--- Install ---${RESET}"
    echo "  1.  Claude Code           (Anthropic official native installer)"
    echo "  2.  Qwen Code"
    echo "  3.  OpenCode CLI"
    echo "  4.  Hermes (Nous Research)"
    echo ""
    echo -e "${YELLOW}--- Uninstall ---${RESET}"
    echo "  5.  Claude Code"
    echo "  6.  Qwen Code"
    echo "  7.  OpenCode CLI"
    echo "  8.  Hermes"
    echo -e "\n${GRAY}  q.  Quit${RESET}"
    echo "--------------------------------"
    read -r -p ">>> Select: " choice

    case "$choice" in
        1)
            echo -e "\n${CYAN}  Installing Claude Code (native installer)...${RESET}\n"
            if curl -fsSL https://claude.ai/install.sh | bash; then
                print_success "Claude Code" "https://claude.ai/code" "claude --version"
            else
                echo -e "${RED}  [Error] Install failed.${RESET}"
                echo -en "  Press Enter to continue..."
                read -r
            fi
            ;;
        2)
            echo -e "\n${CYAN}  Installing Qwen Code...${RESET}\n"
            if ensure_npm && bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)" -s --source qwenchat; then
                print_success "Qwen Code" "https://qwen.ai/qwencode" "qwen --version"
            else
                echo -e "${RED}  [Error] Install failed.${RESET}"
                echo -en "  Press Enter to continue..."
                read -r
            fi
            ;;
        3)
            echo -e "\n${CYAN}  Installing OpenCode CLI...${RESET}\n"
            if ensure_npm && run_install "OpenCode" npm install -g opencode-ai@latest "${registryArgs[@]}"; then
                print_success "OpenCode CLI" "https://opencode.ai" "opencode --version"
            fi
            ;;
        4)
            echo -e "\n${CYAN}  Installing Hermes (Nous Research)...${RESET}\n"
            if bash <(curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh); then
                print_success "Hermes" "https://hermes-agent.nousresearch.com" "hermes --version"
            else
                echo -e "${RED}  [Error] Install failed.${RESET}"
                echo -en "  Press Enter to continue..."
                read -r
            fi
            ;;
        5)
            echo -e "\n${YELLOW}  Uninstalling Claude Code (native)...${RESET}\n"
            rm -f "$HOME/.local/bin/claude" 2>/dev/null
            rm -rf "$HOME/.local/share/claude" 2>/dev/null
            echo -e "${GREEN}  [OK] Claude Code uninstalled.${RESET}"
            echo -en "  Press Enter to continue..."
            read -r
            ;;
        6)
            echo -e "\n${YELLOW}  Uninstalling Qwen Code...${RESET}\n"
            run_uninstall "Qwen Code" npm uninstall -g @qwen-code/qwen-code
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
