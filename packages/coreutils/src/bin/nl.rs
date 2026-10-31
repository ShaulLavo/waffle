extern crate uu_nl as upstream_nl;
extern crate uucore_files as uucore;

mod file_operations;
mod nl_bre;

mod uu_nl {
    use std::ffi::OsString;

    pub fn uumain(args: impl uucore::Args) -> i32 {
        #[cfg(target_os = "wasi")]
        super::file_operations::initialize_cwd("nl");
        let original: Vec<OsString> = args.collect();
        let Ok(matches) = upstream_nl::uu_app().try_get_matches_from(&original) else {
            return upstream_nl::uumain(original.into_iter());
        };
        match super::nl_bre::arguments(&matches) {
            Ok(normalized) => upstream_nl::uumain(normalized.into_iter()),
            Err(message) => {
                eprintln!("nl: {message}");
                1
            }
        }
    }
}

uucore::bin!(uu_nl);
