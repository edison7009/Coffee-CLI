// Desktop builds of the shell are only for trying it out; the phone starts from `run` in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    coffee_cli_mobile_lib::run()
}
