extern crate uu_date as upstream_date;

#[path = "../../../src/bin/file_operations/mod.rs"]
mod file_operations;

mod uu_date {
    use std::ffi::OsString;

    pub fn uumain(args: impl uucore::Args) -> i32 {
        #[cfg(target_os = "wasi")]
        super::file_operations::initialize_cwd("date");
        let original: Vec<OsString> = args.collect();
        let Ok(matches) = upstream_date::uu_app().try_get_matches_from(&original) else {
            return upstream_date::uumain(original.into_iter());
        };
        if matches.contains_id("set") {
            eprintln!("date: setting the clock is not supported");
            return 1;
        }
        upstream_date::uumain(original.into_iter())
    }
}

uucore::bin!(uu_date);
