# third-party.sh — Placeholder sub-menu. Sourced by menu.sh.
# Swap this file's content to add new integrations; users re-running the
# installer pick it up on next session.
#
# Depends on: coffee_t (menu.sh).

clear
printf '\n  \033[36m%s\033[0m\n' "$(coffee_t third-party title)"
printf '  \033[90m--------------------\033[0m\n\n'
printf '  \033[33m%s\033[0m\n\n' "$(coffee_t third-party msg.coming_soon)"
printf '  \033[90m%s\033[0m\n' "$(coffee_t third-party msg.detail_1)"
printf '  \033[90m%s\033[0m\n' "$(coffee_t third-party msg.detail_2)"
printf '  \033[90m%s\033[0m\n\n' "$(coffee_t third-party msg.detail_3)"
_tp_reply=
read -r -p "  $(coffee_t third-party prompt.press_enter) " _tp_reply
