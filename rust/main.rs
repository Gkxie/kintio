use std::io;
use std::process::ExitCode;

use kintio_native::{CliContext, run_cli};

fn main() -> ExitCode {
    let context = match CliContext::system() {
        Ok(context) => context,
        Err(error) => {
            eprintln!("{error:#}");
            return ExitCode::FAILURE;
        }
    };
    let mut stdout = io::stdout().lock();
    match run_cli(std::env::args_os(), &context, &mut stdout) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::FAILURE
        }
    }
}
