//! hangar-core — the portable heart of Hangar.
//!
//! Everything here is a port of the Node modules under `lib/`, which shipped
//! first and carry 55 tests written from real field bugs. Those tests are the
//! behavioural contract: a Rust module does not replace its JS counterpart
//! until it reproduces every case.
//!
//! The JS modules were written as pure functions — verdicts in, verdicts out,
//! no logging, no I/O — as a safety response to the 2026-07-29 incident where
//! a log statement inside a guard corrupted its own result. That purity is
//! also what makes this port mechanical rather than a rewrite.

pub mod attribute;
pub mod collect;
pub mod guard;
pub mod persistence;
pub mod types;

pub use types::*;
