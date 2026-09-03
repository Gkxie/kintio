mod config;
mod setup;

pub use setup::{CliContext, INSTANCE_CONFIG_TEMPLATE, MANAGED_SKILL_CONTENT, run_cli};

#[cfg(test)]
mod tests;
