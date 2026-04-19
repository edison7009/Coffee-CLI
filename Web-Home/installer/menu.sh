# menu.sh — Root menu + shared helpers. Sourced by agent-tools-installer.sh.
#
# Exposes globally (sub-scripts reuse them after source):
#   coffee_show_menu       arrow-key selector with Esc-to-back
#   coffee_source_submenu  fetch + source a sub-menu script (with error UI)
#   coffee_get_lang        resolve UI locale (user pref > Claude active-language > OS > en)
#   coffee_set_lang        persist user locale choice
#   coffee_t               look up a key in a menu JSON, interpolate {vars}
#
# Depends on: coffee_cache_get / coffee_fetch / coffee_source (bootstrap).

_COFFEE_SUPPORTED_LANGS=(
    "en"    "English"
    "zh-CN" "简体中文"
    "zh-TW" "繁體中文"
    "ja"    "日本語"
    "ko"    "한국어"
    "es"    "Español"
    "fr"    "Français"
    "de"    "Deutsch"
    "pt"    "Português"
    "ru"    "Русский"
    "vi"    "Tiếng Việt"
)

coffee_get_lang() {
    local pref="$HOME/.coffee-cli/installer-lang"
    local v
    if [[ -f "$pref" ]]; then
        v=$(tr -d '[:space:]' < "$pref" 2>/dev/null)
        [[ -n "$v" ]] && { printf '%s' "$v"; return; }
    fi
    local active="$HOME/.coffee-cli/active-language"
    if [[ -f "$active" ]]; then
        v=$(tr -d '[:space:]' < "$active" 2>/dev/null)
        [[ -n "$v" ]] && { printf '%s' "$v"; return; }
    fi
    local loc="${LANG:-${LC_ALL:-en_US}}"
    case "$loc" in
        zh_TW*|zh_HK*|zh_MO*|zh-TW*|zh-HK*|zh-MO*) printf 'zh-TW' ;;
        zh_*|zh-*|zh*)                              printf 'zh-CN' ;;
        ja*)  printf 'ja' ;;
        ko*)  printf 'ko' ;;
        es*)  printf 'es' ;;
        fr*)  printf 'fr' ;;
        de*)  printf 'de' ;;
        pt*)  printf 'pt' ;;
        ru*)  printf 'ru' ;;
        vi*)  printf 'vi' ;;
        *)    printf 'en' ;;
    esac
}

coffee_set_lang() {
    local code="$1"
    local dir="$HOME/.coffee-cli"
    mkdir -p "$dir" 2>/dev/null
    printf '%s' "$code" > "$dir/installer-lang"
}

# Flat i18n parser. Expects pretty-printed JSON:
#   { "key": { "lang": "value", ... }, ... }
# Outputs key<TAB>lang<TAB>value lines. Tolerates \" and \\ in values.
_coffee_i18n_parse() {
    awk '
        BEGIN { key = "" }
        {
            line = $0
            sub(/^[ \t]+/, "", line)
            sub(/[ \t\r]+$/, "", line)
            if (match(line, /^"[^"]*"[ \t]*:[ \t]*[{]$/)) {
                q1 = index(line, "\"")
                rest = substr(line, q1 + 1)
                q2 = index(rest, "\"")
                key = substr(rest, 1, q2 - 1)
                next
            }
            if (match(line, /^"[^"]+"[ \t]*:[ \t]*".*"[,]?$/)) {
                if (key == "") next
                q1 = index(line, "\"")
                rest = substr(line, q1 + 1)
                q2 = index(rest, "\"")
                lang = substr(rest, 1, q2 - 1)
                after = substr(rest, q2 + 1)
                cq = index(after, "\"")
                vraw = substr(after, cq + 1)
                n = length(vraw)
                while (n > 0 && substr(vraw, n, 1) != "\"") n--
                val = substr(vraw, 1, n - 1)
                print key "\t" lang "\t" val
                next
            }
            if (line == "}" || line == "},") { key = "" }
        }
    ' "$1"
}

_coffee_i18n_ensure() {
    local menu="$1"
    local tsv="$COFFEE_CACHE_DIR/i18n_${menu}.tsv"
    [[ -f "$tsv" ]] && return 0
    local json_path
    json_path=$(coffee_cache_get "i18n/${menu}.json") || return 1
    _coffee_i18n_parse "$json_path" > "$tsv"
    [[ -s "$tsv" ]]
}

# coffee_t <menu> <key> [var1 val1 var2 val2 ...]
coffee_t() {
    local menu="$1" key="$2"
    shift 2
    local lang="${COFFEE_LANG:-en}"
    local tsv="$COFFEE_CACHE_DIR/i18n_${menu}.tsv"
    [[ -f "$tsv" ]] || _coffee_i18n_ensure "$menu" || { printf '%s' "$key"; return; }
    local text
    text=$(awk -F '\t' -v k="$key" -v l="$lang" '
        $1==k && $2==l { for (i=3; i<=NF; i++) printf "%s%s", (i>3?"\t":""), $i; exit }
    ' "$tsv")
    if [[ -z "$text" ]]; then
        text=$(awk -F '\t' -v k="$key" '
            $1==k && $2=="en" { for (i=3; i<=NF; i++) printf "%s%s", (i>3?"\t":""), $i; exit }
        ' "$tsv")
    fi
    [[ -z "$text" ]] && text="$key"
    text="${text//\\\"/\"}"
    text="${text//\\\\/\\}"
    while [[ $# -ge 2 ]]; do
        text="${text//\{$1\}/$2}"
        shift 2
    done
    printf '%s' "$text"
}

# Arrow key reader. Emits UP / DOWN / ENTER / ESC / OTHER on stdout.
coffee_read_key() {
    local k1 k2
    IFS= read -rsn1 k1
    if [[ $k1 == $'\x1b' ]]; then
        IFS= read -rsn2 -t 0.05 k2 2>/dev/null || k2=""
        case "$k2" in
            "[A") echo UP ;;
            "[B") echo DOWN ;;
            "")   echo ESC ;;
            *)    echo OTHER ;;
        esac
    elif [[ -z $k1 ]]; then
        echo ENTER
    else
        case "$k1" in
            $'\n'|$'\r') echo ENTER ;;
            q|Q)         echo ESC ;;
            *)           echo OTHER ;;
        esac
    fi
}

: "${_COFFEE_MENU_DEPTH:=0}"

# coffee_show_menu <title> <root|sub> <label1> <value1> <label2> <value2> ...
# Sets COFFEE_MENU_CHOICE to selected value string (e.g. "target:agents.sh",
# "action:__back__"). ESC sets it to "action:__back__".
coffee_show_menu() {
    local title="$1" root_flag="$2"
    shift 2
    local labels=() values=()
    while [[ $# -ge 2 ]]; do
        labels+=("$1"); values+=("$2"); shift 2
    done
    local count=${#labels[@]}
    local nav_hint
    if [[ "$root_flag" == "root" ]]; then
        nav_hint=$(coffee_t menu "nav.root_hint")
    else
        nav_hint=$(coffee_t menu "nav.sub_hint")
    fi
    local sel=0
    ((_COFFEE_MENU_DEPTH++))
    [[ $_COFFEE_MENU_DEPTH -eq 1 ]] && printf '\033[?25l'
    local dashes
    printf -v dashes '%*s' 60 ''
    dashes="${dashes// /-}"
    while true; do
        clear
        printf '\n  \033[36m%s\033[0m\n' "$title"
        printf '  \033[90m%s\033[0m\n' "$dashes"
        printf '  \033[90m%s\033[0m\n\n' "$nav_hint"
        local i
        for ((i = 0; i < count; i++)); do
            if (( i == sel )); then
                printf '  \033[1;46;37m> %-52s\033[0m\n' "${labels[$i]}"
            else
                printf '    %s\n' "${labels[$i]}"
            fi
        done
        printf '\n'
        local key
        key=$(coffee_read_key)
        case "$key" in
            UP)    (( sel = sel == 0 ? count - 1 : sel - 1 )) ;;
            DOWN)  (( sel = sel == count - 1 ? 0 : sel + 1 )) ;;
            ENTER)
                COFFEE_MENU_CHOICE="${values[$sel]}"
                ((_COFFEE_MENU_DEPTH--))
                [[ $_COFFEE_MENU_DEPTH -eq 0 ]] && printf '\033[?25h'
                return 0
                ;;
            ESC)
                COFFEE_MENU_CHOICE="action:__back__"
                ((_COFFEE_MENU_DEPTH--))
                [[ $_COFFEE_MENU_DEPTH -eq 0 ]] && printf '\033[?25h'
                return 0
                ;;
        esac
    done
}

coffee_source_submenu() {
    local name="$1"
    if ! coffee_source "$name"; then
        clear
        printf '\n  \033[31m%s\033[0m\n\n' "$(coffee_t menu common.error_load_submenu name "$name")"
        local _
        read -r -p "  $(coffee_t menu common.press_enter_continue) " _
    fi
}

_coffee_lang_picker() {
    local args=() i code name suffix
    for ((i = 0; i < ${#_COFFEE_SUPPORTED_LANGS[@]}; i += 2)); do
        code="${_COFFEE_SUPPORTED_LANGS[$i]}"
        name="${_COFFEE_SUPPORTED_LANGS[$((i + 1))]}"
        suffix=""
        [[ "$code" == "$COFFEE_LANG" ]] && suffix="  *"
        args+=("$name$suffix" "lang:$code")
    done
    args+=("$(coffee_t menu root.exit)" "action:__back__")
    coffee_show_menu "$(coffee_t menu lang_picker.title)" "sub" "${args[@]}"
    case "$COFFEE_MENU_CHOICE" in
        action:__back__) return ;;
        lang:*)
            local chosen="${COFFEE_MENU_CHOICE#lang:}"
            coffee_set_lang "$chosen"
            COFFEE_LANG="$chosen"
            clear
            printf '\n  \033[32m%s\033[0m\n\n' "$(coffee_t menu lang_picker.saved)"
            sleep 0.7
            ;;
    esac
}

# --- Root menu loop -----------------------------------------------------

COFFEE_LANG=$(coffee_get_lang)

while true; do
    _coffee_root_items=(
        "$(coffee_t menu root.install_agents)"  "target:agents.sh"
        "$(coffee_t menu root.third_party)"     "target:third-party.sh"
        "$(coffee_t menu root.language_picker)" "action:__lang__"
        "$(coffee_t menu root.exit)"            "action:__exit__"
    )
    coffee_show_menu "$(coffee_t menu title)" "root" "${_coffee_root_items[@]}"
    case "$COFFEE_MENU_CHOICE" in
        action:__exit__|action:__back__)
            clear
            printf '\n  %s\n\n' "$(coffee_t menu common.goodbye)"
            break
            ;;
        action:__lang__)
            _coffee_lang_picker
            ;;
        target:*)
            coffee_source_submenu "${COFFEE_MENU_CHOICE#target:}"
            ;;
    esac
done
